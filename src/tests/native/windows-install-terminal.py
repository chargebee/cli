"""Exercise the released Windows CLI through the installer's real console prompts.

Run only in a disposable Windows session; requires pywinpty. The loopback server
serves this checkout's unchanged installer, while release downloads and checksum
verification use GitHub. No API credentials or prompt mocks are involved.
"""

import argparse
import base64
import http.server
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import time


def plain(text):
    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)


def run_case(shell, release, url, answer):
    from winpty import PtyProcess
    from winpty.enums import Backend

    with tempfile.TemporaryDirectory(prefix="cb-windows-terminal-") as temp:
        root = Path(temp)
        target_home = root / "home"
        for agent in (".cursor", ".claude", ".codex"):
            (target_home / agent).mkdir(parents=True)
        profile = root / "profile.ps1"
        # Do not inherit CI=1 (which disables onboarding), tokens, or a user's
        # configured agent directories. All resulting files stay in this fixture.
        keep = {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "OS",
                "PROCESSOR_ARCHITECTURE", "TEMP", "TMP"}
        env = {key.upper(): value for key, value in os.environ.items() if key.upper() in keep}
        env.update({
            "HOME": str(target_home), "USERPROFILE": str(target_home),
            "APPDATA": str(root / "AppData" / "Roaming"),
            "LOCALAPPDATA": str(root / "AppData" / "Local"),
            "CHARGEBEE_CONFIG_DIR": str(root / "config"),
            "CHARGEBEE_CLI_BIN_DIR": str(root / "bin"),
            "CHARGEBEE_CLI_VERSION": release, "DO_NOT_TRACK": "1",
            "TERM": "xterm-256color",
        })
        # Override only the destination of alias writes; the real Read-Host and
        # CLI prompts run inside ConPTY, including the nested picker if present.
        escaped_profile = str(profile).replace("'", "''")
        command = (
            "$ErrorActionPreference = 'Stop'; "
            f"$PROFILE = '{escaped_profile}'; "
            f"try {{ irm '{url}' | iex; Write-Output '__CB_INSTALL_COMPLETE__'; exit 0 }} "
            "catch { Write-Output $_; exit 1 }"
        )
        encoded = base64.b64encode(command.encode("utf-16-le")).decode("ascii")
        proc = PtyProcess.spawn(
            [shell, "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            cwd=temp, env=env, dimensions=(60, 200), backend=Backend.ConPTY,
        )
        chunks = queue.Queue()

        def read_output():
            try:
                while True:
                    chunks.put(proc.read(4096))
            except (EOFError, OSError):
                chunks.put(None)

        threading.Thread(target=read_output, daemon=True).start()
        output = ""
        skill_answered = alias_answered = picker_answered = False
        cursor_queries = 0
        started = time.monotonic()
        exited_at = None
        try:
            while time.monotonic() - started < 120:
                try:
                    chunk = chunks.get(timeout=0.1)
                except queue.Empty:
                    chunk = ""
                if chunk:
                    output += chunk
                    # ConPTY/PowerShell may query the terminal cursor location.
                    queries = output.count("\x1b[6n")
                    while cursor_queries < queries:
                        proc.write("\x1b[1;1R")
                        cursor_queries += 1
                    visible = plain(output)
                    if not skill_answered and re.search(r"Install the Chargebee CLI skill.*?\[Y/n\]", visible):
                        assert not list(target_home.rglob("SKILL.md")), "Skill installed before consent"
                        proc.write(answer + "\r")
                        skill_answered = True
                    if not picker_answered and "Select agents" in visible:
                        # Baseline behavior: accept the detected agents just as
                        # a user would, so a picker input hang hits the deadline.
                        proc.write("\r")
                        picker_answered = True
                    if not alias_answered and re.search(r"Add a cb shortcut.*?\[Y/n\]", visible):
                        assert not profile.exists(), "Alias written before consent"
                        proc.write(answer + "\r")
                        alias_answered = True
                if not proc.isalive():
                    exited_at = exited_at or time.monotonic()
                    if chunk is None or time.monotonic() - exited_at > 1:
                        break
            assert not proc.isalive(), "Installer timed out waiting for terminal input"
            assert proc.exitstatus == 0, f"Installer exit status: {proc.exitstatus}"
            assert skill_answered and alias_answered, "Installer skipped onboarding prompts"
            assert "__CB_INSTALL_COMPLETE__" in output, "Installer did not complete"
            binary = root / "bin" / "chargebee.exe"
            version = subprocess.check_output([str(binary), "--version"], env=env, text=True, timeout=15).strip()
            assert version == release.removeprefix("v"), version
            skills = list(target_home.rglob("SKILL.md"))
            if answer == "n":
                assert not skills, f"Declining installed skills: {skills}"
                assert not profile.exists(), "Declining created an alias"
            else:
                expected = {target_home / agent / "skills" / "chargebee-cli" / "SKILL.md"
                            for agent in (".cursor", ".claude", ".codex")}
                assert set(skills) == expected, f"Incorrect global skill paths: {skills}"
                assert all("name: chargebee-cli" in path.read_text(encoding="utf-8") for path in skills)
                assert "Set-Alias cb" in profile.read_text(encoding="utf-8"), "Alias was not installed"
            print(f"PASS {Path(shell).name}: answer={answer or 'Enter'}, version={version}, "
                  f"skills={len(skills)}, picker={picker_answered}, seconds={time.monotonic()-started:.1f}", flush=True)
        except Exception:
            print(plain(output), flush=True)
            raise
        finally:
            if proc.isalive():
                subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=15)
            proc.close(force=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shell", choices=("powershell", "pwsh"), required=True)
    parser.add_argument("--release", required=True)
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("This test requires a disposable Windows session")
    shell = shutil.which(args.shell)
    if not shell:
        parser.error(f"Missing shell: {args.shell}")
    installer = Path(__file__).resolve().parents[3] / "install.ps1"

    class InstallerHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = installer.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), InstallerHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    failures = []
    try:
        for answer in ("y", "n", ""):
            try:
                run_case(shell, args.release, f"http://127.0.0.1:{server.server_port}/install.ps1", answer)
            except Exception as error:
                failures.append(f"{answer or 'Enter'}: {error}")
                print(f"FAIL {args.shell}: {failures[-1]}", flush=True)
    finally:
        server.shutdown()
        server.server_close()
    if failures:
        raise SystemExit("\n".join(failures))


if __name__ == "__main__":
    main()
