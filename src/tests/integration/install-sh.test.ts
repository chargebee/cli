/**
 * Contract for install.sh: snapshot mode (local file + bindir, no GitHub),
 * pinned downloads, and stable-release resolution through the releases API
 * (a fake `curl` on PATH answers both). Unix only — the script refuses Windows.
 */
import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL_SH = join(import.meta.dir, "../../../install.sh");
/**
 * System dirs only, for the tools the script itself needs (bash, uname,
 * mktemp, shasum/sha256sum, sed, ...). No user dirs, so a `chargebee` installed
 * on the developer's machine is never picked up by the script's
 * `command -v chargebee` pre-check.
 */
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** Hard deadline for one install.sh run: a hang fails the test fast instead of stalling the suite. */
const RUN_TIMEOUT_MS = 120_000;

/**
 * A closed environment for the script: nothing from the test process leaks in
 * (no tokens, no pinned version, no PATH entries), so every run is hermetic
 * and independent of whatever the test files before it did to `process.env`.
 */
function hermeticEnv(env: Record<string, string>): Record<string, string> {
  return {
    PATH: SYSTEM_PATH,
    HOME: process.env.HOME ?? "/",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    TERM: "dumb",
    CI: "1",
    CHARGEBEE_CLI_NO_ONBOARDING: "1",
    ...env,
  };
}
const API_URL = "https://api.github.com/repos/chargebee/cli/releases/latest";

/**
 * Fake curl: appends each argv to `log` (one call per line, NUL-free join),
 * answers the releases API URL with `apiBody` on stdout, answers any
 * `SHA256SUMS.txt` URL with a matching sum for the stub asset below (so the
 * default fake serves a valid checksum), and for any other URL writes a
 * runnable stub binary to the -o target and prints "200" for -w.
 */
function writeFakeCurl(dir: string, log: string, apiBody: string): void {
  writeFileSync(
    join(dir, "curl"),
    `#!/usr/bin/env bash
printf '%s ' "$@" >> "${log}"; printf '\n' >> "${log}"
out=""; url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -H|-w) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ "$url" == "${API_URL}" ]]; then
  printf '%s' '${apiBody}'
  exit 0
fi
if [[ "$url" == *"/SHA256SUMS.txt" ]]; then
  hash=$(printf '#!/bin/sh\necho 9.9.9\n' | shasum -a 256 | cut -d' ' -f1)
  printf '%s  chargebee-cli-darwin-arm64\n%s  chargebee-cli-darwin-x64\n%s  chargebee-cli-linux-arm64\n%s  chargebee-cli-linux-x64\n' \
    "$hash" "$hash" "$hash" "$hash" > "$out"
  printf '200'
  exit 0
fi
printf '#!/bin/sh\necho 9.9.9\n' > "$out"
printf '200'
`,
  );
  chmodSync(join(dir, "curl"), 0o755);
}

/**
 * Fake curl for checksum-specific scenarios: the releases API always answers
 * with a single release `v9.9.9`; asset downloads always succeed with the
 * fixed stub binary; `SHA256SUMS.txt` behaviour is controlled by `opts`.
 */
function writeChecksumFakeCurl(
  dir: string,
  log: string,
  opts: { sumsMissing?: boolean; badSum?: boolean },
): void {
  writeFileSync(
    join(dir, "curl"),
    `#!/usr/bin/env bash
printf '%s ' "$@" >> "${log}"; printf '\n' >> "${log}"
out=""; url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -H|-w) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ "$url" == "${API_URL}" ]]; then
  printf '%s' '[{"tag_name": "v9.9.9", "draft": false, "prerelease": false, "assets": []}]'
  exit 0
fi
if [[ "$url" == *"/SHA256SUMS.txt" ]]; then
  ${opts.sumsMissing ? "exit 22" : ""}
  hash=$(printf '#!/bin/sh\necho 9.9.9\n' | shasum -a 256 | cut -d' ' -f1)
  ${opts.badSum ? 'hash="0000000000000000000000000000000000000000000000000000000000000000"' : ""}
  printf '%s  chargebee-cli-darwin-arm64\n%s  chargebee-cli-darwin-x64\n%s  chargebee-cli-linux-arm64\n%s  chargebee-cli-linux-x64\n' \
    "$hash" "$hash" "$hash" "$hash" > "$out"
  printf '200'
  exit 0
fi
printf '#!/bin/sh\necho 9.9.9\n' > "$out"
printf '200'
`,
  );
  chmodSync(join(dir, "curl"), 0o755);
}

function runInstall(env: Record<string, string>, args: string[] = [], script = INSTALL_SH): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const proc = Bun.spawnSync(["bash", script, ...args], {
    env: hermeticEnv(env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: RUN_TIMEOUT_MS,
  });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe.skipIf(process.platform === "win32")("install.sh onboarding compatibility", () => {
  for (const modern of [false, true]) {
    for (const force of [false, true]) {
      it(`uses ${modern ? "global" : "legacy"} skills flags and ${force ? "forwards" : "does not enable"} alias force`, () => {
        const root = mkdtempSync(join(tmpdir(), "cb-onboarding-"));
        try {
          const home = join(root, "user home");
          mkdirSync(home);
          const calls = join(root, "calls");
          const binary = join(root, "fixture-cli");
          writeFileSync(binary, `#!/bin/bash
if [[ "$1" == "--version" ]]; then echo 1.4.0-beta.3; exit 0; fi
if [[ "$*" == "skills add --help" ]]; then echo '${modern ? "--global" : "--path <dir>"}'; exit 0; fi
printf '<%s>' "$@" >> '${calls}'; printf '\\n' >> '${calls}'
if [[ "$1" == skills && "$3" != '${modern ? "--global" : "--path"}' ]]; then exit 1; fi
`);
          chmodSync(binary, 0o755);
          const script = join(root, "install.sh");
          // Run the real main; only replace terminal detection and yes/no input.
          writeFileSync(script, readFileSync(INSTALL_SH, "utf8").replace(/< \/dev\/tty/g, "< /dev/null").replace(/main "\$@"\s*$/, `
onboarding_can_prompt() { return 0; }
onboarding_prompt_yn() { return 0; }
main "$@"
`));
          const result = runInstall({
            HOME: home,
            CHARGEBEE_CLI_INSTALL_FILE: binary,
            CHARGEBEE_CLI_BIN_DIR: join(root, "bin"),
            CHARGEBEE_CONFIG_DIR: join(root, "config"),
          }, force ? ["--force"] : [], script);
          expect(result.exitCode).toBe(0);
          expect(result.stderr).toBe("");
          expect(readFileSync(calls, "utf8").split("\n")).toEqual([
            modern ? "<skills><add><--global><--yes>" : `<skills><add><--path><${home}><--no-gitignore><--yes>`,
            force ? "<alias><set><--force>" : "<alias><set>",
            "",
          ]);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }

  it("rejects unsupported installer flags before installing", () => {
    const result = runInstall({}, ["--unknown"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown installer option: --unknown");
    expect(result.stdout).not.toContain("Installing");
  });

  it("explains --force without downloading", () => {
    const result = runInstall({}, ["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Replace an existing alias");
    expect(result.stdout).not.toContain("Installing");
  });
});

describe.skipIf(process.platform === "win32")("install.sh snapshot mode", () => {
  it("copies CHARGEBEE_CLI_INSTALL_FILE into CHARGEBEE_CLI_BIN_DIR and writes github marker", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-install-sh-"));
    try {
      const binDir = join(root, "bin");
      const configDir = join(root, "config");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(configDir, { recursive: true });
      const src = join(root, "fake-chargebee");
      writeFileSync(src, "#!/bin/sh\necho 0.9.0-snapshot\n");
      chmodSync(src, 0o755);

      const result = runInstall({
        CHARGEBEE_CLI_INSTALL_FILE: src,
        CHARGEBEE_CLI_BIN_DIR: binDir,
        CHARGEBEE_CONFIG_DIR: configDir,
        HOME: root,
        PATH: `${binDir}:${SYSTEM_PATH}`,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("GitHub API");

      const installed = join(binDir, "chargebee");
      const version = Bun.spawnSync([installed, "--version"]);
      expect(version.stdout.toString()).toContain("0.9.0-snapshot");
      expect(readFileSync(join(configDir, "install-method"), "utf8").trim()).toBe("github");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs the binary as 0755", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-install-sh-mode-"));
    try {
      const binDir = join(root, "bin");
      const configDir = join(root, "config");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(configDir, { recursive: true });
      const src = join(root, "fake-chargebee");
      writeFileSync(src, "#!/bin/sh\necho 0.9.0-snapshot\n");
      chmodSync(src, 0o755);

      const result = runInstall({
        CHARGEBEE_CLI_INSTALL_FILE: src,
        CHARGEBEE_CLI_BIN_DIR: binDir,
        CHARGEBEE_CONFIG_DIR: configDir,
        HOME: root,
        PATH: `${binDir}:${SYSTEM_PATH}`,
      });
      expect(result.exitCode).toBe(0);
      expect(statSync(join(binDir, "chargebee")).mode & 0o777).toBe(0o755);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("PATH hint names the actual bin dir instead of a hardcoded ~/.local/bin", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-install-sh-pathhint-"));
    try {
      const binDir = join(root, "not-on-path", "bin");
      const configDir = join(root, "config");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(configDir, { recursive: true });
      const src = join(root, "fake-chargebee");
      writeFileSync(src, "#!/bin/sh\necho 0.9.0-snapshot\n");
      chmodSync(src, 0o755);

      const result = runInstall({
        CHARGEBEE_CLI_INSTALL_FILE: src,
        CHARGEBEE_CLI_BIN_DIR: binDir,
        CHARGEBEE_CONFIG_DIR: configDir,
        HOME: root,
        PATH: process.env.PATH ?? "",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`export PATH="${binDir}:$PATH"`);
      expect(result.stdout).not.toContain("$HOME/.local/bin");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("under sudo, hands the config dir it created back to the invoking user", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-install-sh-sudo-"));
    try {
      const binDir = join(root, "bin");
      const configDir = join(root, "config");
      const fakeBin = join(root, "fakebin");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      const src = join(root, "fake-chargebee");
      writeFileSync(src, "#!/bin/sh\necho 0.9.0-snapshot\n");
      chmodSync(src, 0o755);
      // `id -u` reports root and `chown` only records its argv.
      const chownLog = join(root, "chown.log");
      writeFileSync(join(fakeBin, "id"), "#!/bin/sh\necho 0\n");
      writeFileSync(join(fakeBin, "chown"), `#!/bin/sh\nprintf '%s ' "$@" >> "${chownLog}"; printf '\\n' >> "${chownLog}"\n`);
      chmodSync(join(fakeBin, "id"), 0o755);
      chmodSync(join(fakeBin, "chown"), 0o755);

      const result = runInstall({
        CHARGEBEE_CLI_INSTALL_FILE: src,
        CHARGEBEE_CLI_BIN_DIR: binDir,
        CHARGEBEE_CONFIG_DIR: configDir,
        HOME: root,
        SUDO_USER: "cb-invoking-user",
        PATH: `${fakeBin}:${binDir}:${SYSTEM_PATH}`,
      });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(configDir, "install-method"), "utf8")).toBe("github\n");
      expect(readFileSync(chownLog, "utf8")).toContain(`-R cb-invoking-user ${configDir}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("a script truncated before the final main call runs nothing (curl | bash partial download)", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-install-sh-truncated-"));
    try {
      const binDir = join(root, "bin");
      const configDir = join(root, "config");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(configDir, { recursive: true });
      const src = join(root, "fake-chargebee");
      writeFileSync(src, "#!/bin/sh\necho 0.9.0-snapshot\n");
      chmodSync(src, 0o755);

      const full = readFileSync(INSTALL_SH, "utf8");
      const callIdx = full.lastIndexOf('main "$@"');
      expect(callIdx).toBeGreaterThan(-1);
      // Cut well before the closing brace of main() and its call, simulating
      // a `curl | bash` stream that died partway through the download.
      const truncated = full.slice(0, Math.floor(callIdx * 0.9));
      const truncatedPath = join(root, "install-truncated.sh");
      writeFileSync(truncatedPath, truncated);

      const proc = Bun.spawnSync(["bash", truncatedPath], {
        env: hermeticEnv({
          CHARGEBEE_CLI_INSTALL_FILE: src,
          CHARGEBEE_CLI_BIN_DIR: binDir,
          CHARGEBEE_CONFIG_DIR: configDir,
          HOME: root,
          PATH: `${binDir}:${SYSTEM_PATH}`,
        }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: RUN_TIMEOUT_MS,
      });
      expect(proc.exitCode).not.toBe(0);
      expect(existsSync(join(binDir, "chargebee"))).toBe(false);
      expect(existsSync(join(configDir, "install-method"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["9.9.9", "9.9.9-beta.1"])("CHARGEBEE_CLI_VERSION pins %s (fake curl)", (version) => {
    const root = mkdtempSync(join(tmpdir(), "cb-install-sh-pin-"));
    try {
      const fakeBin = join(root, "fakebin");
      const binDir = join(root, "bin");
      const configDir = join(root, "config");
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      const log = join(root, "curl-args.log");
      // Records argv, writes a runnable stub to the -o target, prints "200" for -w,
      // and serves a matching SHA256SUMS.txt so checksum verification passes.
      writeFileSync(
        join(fakeBin, "curl"),
        `#!/usr/bin/env bash
printf '%s\n' "$@" >> "${log}"
out=""; url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ "$url" == *"/SHA256SUMS.txt" ]]; then
  hash=$(printf '#!/bin/sh\necho 9.9.9\n' | shasum -a 256 | cut -d' ' -f1)
  printf '%s  chargebee-cli-darwin-arm64\n%s  chargebee-cli-darwin-x64\n%s  chargebee-cli-linux-arm64\n%s  chargebee-cli-linux-x64\n' \
    "$hash" "$hash" "$hash" "$hash" > "$out"
  printf '200'
  exit 0
fi
printf '#!/bin/sh\necho 9.9.9\n' > "$out"
printf '200'
`,
      );
      chmodSync(join(fakeBin, "curl"), 0o755);

      const result = runInstall({
        CHARGEBEE_CLI_VERSION: version,
        CHARGEBEE_CLI_BIN_DIR: binDir,
        CHARGEBEE_CONFIG_DIR: configDir,
        HOME: root,
        PATH: `${fakeBin}:${binDir}:${SYSTEM_PATH}`,
      });
      expect(result.exitCode).toBe(0);
      const args = readFileSync(log, "utf8");
      expect(args).toContain(`https://github.com/chargebee/cli/releases/download/v${version}/chargebee-cli-`);
      expect(args).not.toContain("/releases/latest/");
      expect(Bun.spawnSync([join(binDir, "chargebee"), "--version"]).stdout.toString()).toContain("9.9.9");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves the stable release through the releases API when no version is pinned", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-install-sh-latest-"));
    try {
      const fakeBin = join(root, "fakebin");
      const binDir = join(root, "bin");
      const configDir = join(root, "config");
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      const log = join(root, "curl-args.log");
      // The stable endpoint returns a single release object.
      writeFakeCurl(
        fakeBin,
        log,
        '{"tag_name": "v1.4.0", "draft": false, "prerelease": false, "assets": []}',
      );

      const result = runInstall({
        CHARGEBEE_CLI_BIN_DIR: binDir,
        CHARGEBEE_CONFIG_DIR: configDir,
        HOME: root,
        PATH: `${fakeBin}:${binDir}:${SYSTEM_PATH}`,
      });
      expect(result.exitCode).toBe(0);
      const calls = readFileSync(log, "utf8").trim().split("\n");
      expect(calls).toHaveLength(3);
      expect(calls[0]).toContain(API_URL);
      expect(calls[0]).toContain("Accept: application/vnd.github+json");
      expect(calls[0]).toContain("User-Agent: chargebee-cli-installer");
      expect(calls[1]).toContain(
        "https://github.com/chargebee/cli/releases/download/v1.4.0/chargebee-cli-",
      );
      expect(calls[2]).toContain(
        "https://github.com/chargebee/cli/releases/download/v1.4.0/SHA256SUMS.txt",
      );
      expect(readFileSync(log, "utf8")).not.toContain("/releases/latest/");
      expect(Bun.spawnSync([join(binDir, "chargebee"), "--version"]).stdout.toString()).toContain("9.9.9");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["{}", JSON.stringify({ tag_name: "v1.5.0-beta.1", prerelease: true })])("refuses a missing stable release or prerelease: %s", (body) => {
    const root = mkdtempSync(join(tmpdir(), "cb-install-sh-norelease-"));
    try {
      const fakeBin = join(root, "fakebin");
      const binDir = join(root, "bin");
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      const log = join(root, "curl-args.log");
      writeFakeCurl(fakeBin, log, body);

      const result = runInstall({
        CHARGEBEE_CLI_BIN_DIR: binDir,
        CHARGEBEE_CONFIG_DIR: join(root, "config"),
        HOME: root,
        PATH: `${fakeBin}:${binDir}:${SYSTEM_PATH}`,
      });
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("could not resolve the latest stable release");
      expect(readFileSync(log, "utf8")).not.toContain("/releases/download/");
      expect(existsSync(join(binDir, "chargebee"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when CHARGEBEE_CLI_INSTALL_FILE is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-install-sh-missing-"));
    try {
      const result = runInstall({
        CHARGEBEE_CLI_INSTALL_FILE: join(root, "no-such-binary"),
        CHARGEBEE_CLI_BIN_DIR: join(root, "bin"),
        CHARGEBEE_CONFIG_DIR: join(root, "config"),
        HOME: root,
      });
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("CHARGEBEE_CLI_INSTALL_FILE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("install.sh checksum verification", () => {
  function setup(): { root: string; fakeBin: string; binDir: string; configDir: string; log: string } {
    const root = mkdtempSync(join(tmpdir(), "cb-install-sh-checksum-"));
    const fakeBin = join(root, "fakebin");
    const binDir = join(root, "bin");
    const configDir = join(root, "config");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    return { root, fakeBin, binDir, configDir, log: join(root, "curl-args.log") };
  }

  function baseEnv(t: ReturnType<typeof setup>, extra: Record<string, string> = {}): Record<string, string> {
    return {
      CHARGEBEE_CLI_BIN_DIR: t.binDir,
      CHARGEBEE_CONFIG_DIR: t.configDir,
      HOME: t.root,
      PATH: `${t.fakeBin}:${t.binDir}:${SYSTEM_PATH}`,
      ...extra,
    };
  }

  it("installs when the downloaded asset matches SHA256SUMS.txt", () => {
    const t = setup();
    try {
      writeChecksumFakeCurl(t.fakeBin, t.log, {});
      const result = runInstall(baseEnv(t));
      expect(result.exitCode).toBe(0);
      expect(readFileSync(t.log, "utf8")).toContain("/SHA256SUMS.txt");
      expect(Bun.spawnSync([join(t.binDir, "chargebee"), "--version"]).stdout.toString()).toContain("9.9.9");
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });

  it("aborts and does not install when the checksum does not match", () => {
    const t = setup();
    try {
      writeChecksumFakeCurl(t.fakeBin, t.log, { badSum: true });
      const result = runInstall(baseEnv(t));
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("checksum verification failed");
      expect(existsSync(join(t.binDir, "chargebee"))).toBe(false);
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });

  it("aborts when SHA256SUMS.txt cannot be downloaded", () => {
    const t = setup();
    try {
      writeChecksumFakeCurl(t.fakeBin, t.log, { sumsMissing: true });
      const result = runInstall(baseEnv(t));
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("could not download SHA256SUMS.txt");
      expect(existsSync(join(t.binDir, "chargebee"))).toBe(false);
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });

  it("CHARGEBEE_CLI_SKIP_CHECKSUM=1 skips verification and warns", () => {
    const t = setup();
    try {
      writeChecksumFakeCurl(t.fakeBin, t.log, { sumsMissing: true });
      const result = runInstall(baseEnv(t, { CHARGEBEE_CLI_SKIP_CHECKSUM: "1" }));
      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("skipping checksum verification");
      expect(readFileSync(t.log, "utf8")).not.toContain("/SHA256SUMS.txt");
      expect(Bun.spawnSync([join(t.binDir, "chargebee"), "--version"]).stdout.toString()).toContain("9.9.9");
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("install.sh private-repo asset resolution", () => {
  const TAG_URL = "https://api.github.com/repos/chargebee/cli/releases/tags/v9.9.9";

  // Release-by-tag body in the shape the GitHub API actually serves to curl:
  // one compact line, no whitespace, nested uploader objects between each
  // asset's "url" and the next asset, and a body that contains braces.
  const ASSET_NAMES = [
    "chargebee-cli-darwin-arm64",
    "chargebee-cli-darwin-x64",
    "chargebee-cli-linux-arm64",
    "chargebee-cli-linux-x64",
    "SHA256SUMS.txt",
  ];
  const uploader = { login: "github-actions[bot]", id: 41898282, url: "https://api.github.com/users/github-actions%5Bbot%5D" };
  const RELEASE_BY_TAG_JSON = JSON.stringify({
    url: "https://api.github.com/repos/chargebee/cli/releases/1",
    assets_url: "https://api.github.com/repos/chargebee/cli/releases/1/assets",
    upload_url: "https://uploads.github.com/repos/chargebee/cli/releases/1/assets{?name,label}",
    id: 1,
    author: uploader,
    tag_name: "v9.9.9",
    name: "v9.9.9",
    draft: false,
    prerelease: false,
    assets: ASSET_NAMES.map((name, i) => ({
      url: `https://api.github.com/repos/chargebee/cli/releases/assets/${i + 1}`,
      id: i + 1,
      node_id: `RA_${i + 1}`,
      name,
      label: "",
      uploader,
      content_type: "application/octet-stream",
      state: "uploaded",
      browser_download_url: `https://github.com/chargebee/cli/releases/download/v9.9.9/${name}`,
    })),
    body: "## 9.9.9\n\n* notes with {braces} and a name: chargebee-cli-darwin-arm64 mention",
  });

  /**
   * Fake curl: releases API always resolves to `v9.9.9`; the release-by-tag
   * lookup answers RELEASE_BY_TAG_JSON, whose API-style (`releases/assets/...`)
   * asset URLs cover every asset name githubAssetName() can produce plus
   * SHA256SUMS.txt; those asset URLs serve the stub binary / a matching
   * checksum. Never serves anything from a plain `releases/download/` URL.
   */
  function writeApiOnlyFakeCurl(dir: string, log: string): void {
    writeFileSync(
      join(dir, "curl"),
      `#!/usr/bin/env bash
printf '%s ' "$@" >> "${log}"; printf '\n' >> "${log}"
out=""; url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -H|-w) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ "$url" == "${API_URL}" ]]; then
  printf '%s' '[{"tag_name": "v9.9.9", "draft": false, "prerelease": false, "assets": []}]'
  exit 0
fi
if [[ "$url" == "${TAG_URL}" ]]; then
  printf '%s' '${RELEASE_BY_TAG_JSON}'
  exit 0
fi
if [[ "$url" == "https://api.github.com/repos/chargebee/cli/releases/assets/5" ]]; then
  hash=$(printf '#!/bin/sh\necho 9.9.9\n' | shasum -a 256 | cut -d' ' -f1)
  printf '%s  chargebee-cli-darwin-arm64\n%s  chargebee-cli-darwin-x64\n%s  chargebee-cli-linux-arm64\n%s  chargebee-cli-linux-x64\n' \
    "$hash" "$hash" "$hash" "$hash" > "$out"
  printf '200'
  exit 0
fi
if [[ "$url" == https://api.github.com/repos/chargebee/cli/releases/assets/* ]]; then
  printf '#!/bin/sh\necho 9.9.9\n' > "$out"
  printf '200'
  exit 0
fi
echo "UNEXPECTED URL: $url" >&2
exit 1
`,
    );
    chmodSync(join(dir, "curl"), 0o755);
  }

  it("with a token, resolves and downloads assets through the authenticated API", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-install-sh-token-"));
    try {
      const fakeBin = join(root, "fakebin");
      const binDir = join(root, "bin");
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      const log = join(root, "curl-args.log");
      writeApiOnlyFakeCurl(fakeBin, log);

      const result = runInstall({
        GH_TOKEN: "gh_faketoken",
        CHARGEBEE_CLI_BIN_DIR: binDir,
        CHARGEBEE_CONFIG_DIR: join(root, "config"),
        HOME: root,
        PATH: `${fakeBin}:${binDir}:${SYSTEM_PATH}`,
      });
      expect(result.exitCode).toBe(0);
      const log_contents = readFileSync(log, "utf8");
      expect(log_contents).toContain(TAG_URL);
      expect(log_contents).toContain("Authorization: Bearer gh_faketoken");
      expect(log_contents).not.toContain("/releases/download/");
      expect(Bun.spawnSync([join(binDir, "chargebee"), "--version"]).stdout.toString()).toContain("9.9.9");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("without a token, uses the public releases/download/ URL and sends no Authorization header", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-install-sh-notoken-"));
    try {
      const fakeBin = join(root, "fakebin");
      const binDir = join(root, "bin");
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      const log = join(root, "curl-args.log");
      writeFakeCurl(fakeBin, log, '[{"tag_name": "v9.9.9", "draft": false, "prerelease": false, "assets": []}]');

      const result = runInstall({
        CHARGEBEE_CLI_BIN_DIR: binDir,
        CHARGEBEE_CONFIG_DIR: join(root, "config"),
        HOME: root,
        PATH: `${fakeBin}:${binDir}:${SYSTEM_PATH}`,
      });
      expect(result.exitCode).toBe(0);
      const log_contents = readFileSync(log, "utf8");
      expect(log_contents).toContain("/releases/download/v9.9.9/chargebee-cli-");
      expect(log_contents).not.toContain("Authorization");
      expect(log_contents).not.toContain("/releases/tags/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});


describe.skipIf(process.platform === "win32")("curl-piped installer", () => {
  it("runs skill installation without a nested picker", () => {
    const root = mkdtempSync(join(tmpdir(), "cb-install-curl-"));
    try {
      const home = join(root, "home");
      mkdirSync(home);
      const binary = join(root, "fixture-cli");
      const marker = join(root, "skills-args");
      writeFileSync(binary, `#!/bin/bash
if [[ "$1" == --version ]]; then echo 1.4.0; exit 0; fi
if [[ "$*" == "skills add --help" ]]; then echo --global; exit 0; fi
if [[ "$1" == skills ]]; then printf '%s\\n' "$*" > "$SKILLS_MARKER"; fi
`);
      chmodSync(binary, 0o755);

      const script = join(root, "install.sh");
      writeFileSync(script, readFileSync(INSTALL_SH, "utf8").replace(/main "\$@"\s*$/, `
onboarding_can_prompt() { return 0; }
onboarding_prompt_yn() { [[ "$1" == "Install the Chargebee CLI skill for your coding agent?" ]]; }
main "$@"
`));

      const proc = Bun.spawnSync(["bash", "-c", 'curl -fsSL "file://$INSTALL_SCRIPT" | bash'], {
        env: hermeticEnv({
          HOME: home,
          INSTALL_SCRIPT: script,
          SKILLS_MARKER: marker,
          CHARGEBEE_CLI_INSTALL_FILE: binary,
          CHARGEBEE_CLI_BIN_DIR: join(root, "bin"),
          CHARGEBEE_CONFIG_DIR: join(root, "config"),
        }),
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000,
      });
      expect(proc.exitCode, proc.stdout.toString() + proc.stderr.toString()).toBe(0);
      expect(readFileSync(marker, "utf8").trim()).toBe("skills add --global --yes");
      expect(proc.stdout.toString()).toContain("Get started:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
