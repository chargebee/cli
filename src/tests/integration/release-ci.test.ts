import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../../scripts/release-ci.ts");

describe.skipIf(process.platform === "win32")("release CI command", () => {
  function fixture(options: { extraFile?: boolean; badPackage?: boolean; missingBase?: boolean; failedBase?: boolean; apiError?: boolean; event?: string; mode?: string } = {}) {
    const root = mkdtempSync(join(tmpdir(), "cb-ci-scope-"));
    try {
      const git = (...args: string[]) => {
        const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
        if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
        return proc.stdout.toString().trim();
      };
      git("init", "-q");
      git("config", "user.name", "CI fixture");
      git("config", "user.email", "ci@example.test");
      git("config", "commit.gpgsign", "false");
      function writeMetadata(version: string) {
        writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@example/cli", version }));
        writeFileSync(join(root, ".release-please-manifest.json"), JSON.stringify({ ".": version }));
        writeFileSync(join(root, "CHANGELOG.md"), `## [${version}]\n`);
      }
      writeMetadata("1.4.0-beta.4");
      git("add", ".");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      writeMetadata("1.4.0-beta.5");
      if (options.extraFile) writeFileSync(join(root, "code.ts"), "export const changed = true;");
      if (options.badPackage) writeFileSync(join(root, "package.json"), '{"name":"@example/cli","version":"1.4.0-beta.5","scripts":{"preinstall":"unexpected"}}');
      git("add", ".");
      git("commit", "-qm", "release metadata");
      const head = git("rev-parse", "HEAD");
      const event = join(root, "event.json");
      writeFileSync(event, JSON.stringify({ pull_request: {
        user: { login: "github-actions[bot]", type: "Bot" },
        head: { ref: "release-please--branches--main--components--cli", repo: { full_name: "example/cli" } },
        base: { ref: "main", sha: base },
      } }));
      const calls = join(root, "api-calls");
      const gh = join(root, "gh");
      writeFileSync(gh, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const endpoint = process.argv[3];
appendFileSync(${JSON.stringify(calls)}, endpoint + "\\n");
if (${options.apiError ?? false}) process.exit(1);
const workflow = endpoint.includes("install-smoke.yml") ? "install-smoke.yml" : "ci.yml";
const sha = /head_sha=([a-f0-9]+)/.exec(endpoint)[1];
const runs = ${options.missingBase ?? false} ? [] : [{id:1, head_sha:sha, head_branch:"main", event:"push", path:".github/workflows/"+workflow, status:"completed", conclusion:${JSON.stringify(options.failedBase ? "failure" : "success")}}];
console.log(JSON.stringify({workflow_runs:runs}));
`);
      chmodSync(gh, 0o755);
      const output = join(root, "output");
      const proc = Bun.spawnSync([process.execPath, script, options.mode ?? "scope"], {
        cwd: root,
        env: {
          PATH: `${root}:/usr/bin:/bin`,
          GITHUB_REPOSITORY: "example/cli", GITHUB_SHA: head,
          GITHUB_EVENT_NAME: options.event ?? "pull_request",
          GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output,
        },
        stdout: "pipe", stderr: "pipe", timeout: 5000,
      });
      const read = (file: string) => { try { return readFileSync(file, "utf8"); } catch { return ""; } };
      return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), output: read(output), calls: read(calls), base, head };
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  test("reduces only a metadata diff backed by green exact-base workflows", () => {
    const result = fixture();
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("release_only=true\n");
    expect(result.calls).toContain(`head_sha=${result.base}`);
    expect(result.calls).not.toContain(result.head);
    expect(result.calls).toContain("workflows/ci.yml");
    expect(result.calls).toContain("workflows/install-smoke.yml");
  });
  for (const options of [{ extraFile: true }, { badPackage: true }, { event: "push" }]) {
    test(`takes full CI without querying GitHub for ${JSON.stringify(options)}`, () => {
      const result = fixture(options);
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("release_only=false\n");
      expect(result.calls).toBe("");
    });
  }
  for (const options of [{ missingBase: true }, { failedBase: true }, { apiError: true }]) {
    test(`takes full CI if base validation is unverifiable: ${JSON.stringify(options)}`, () => {
      const result = fixture(options);
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("release_only=false\n");
    });
  }
  test("release gate waits on the current SHA, not the base or latest main", () => {
    const result = fixture({ mode: "wait" });
    expect(result.exitCode).toBe(0);
    expect(result.calls).toContain(`head_sha=${result.head}`);
    expect(result.calls).not.toContain(result.base);
    expect(result.stdout).toContain("install-smoke.yml: success");
  });
  for (const options of [{ failedBase: true }, { apiError: true }]) {
    test(`release gate fails closed for ${JSON.stringify(options)}`, () => {
      expect(fixture({ ...options, mode: "wait" }).exitCode).toBe(1);
    });
  }
});
