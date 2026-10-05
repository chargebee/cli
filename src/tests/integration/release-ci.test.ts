import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "../../../scripts/release-ci.ts");
const sha = "a".repeat(40);

describe.skipIf(process.platform === "win32")("release validation command", () => {
  function fixture(options: { failed?: boolean; apiError?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), "cb-release-validation-"));
    try {
      const calls = join(root, "api-calls");
      const gh = join(root, "gh");
      writeFileSync(gh, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const endpoint = process.argv[3];
appendFileSync(${JSON.stringify(calls)}, endpoint + "\\n");
if (${options.apiError ?? false}) process.exit(1);
const workflow = endpoint.includes("install-smoke.yml") ? "install-smoke.yml" : "ci.yml";
const commit = /head_sha=([a-f0-9]+)/.exec(endpoint)[1];
console.log(JSON.stringify({ workflow_runs: [{ id: 1, head_sha: commit, head_branch: "main", event: "push", path: ".github/workflows/" + workflow, status: "completed", conclusion: ${JSON.stringify(options.failed ? "failure" : "success")} }] }));
`);
      chmodSync(gh, 0o755);
      const proc = Bun.spawnSync([process.execPath, script, "wait"], {
        cwd: root,
        env: { PATH: `${root}:/usr/bin:/bin`, GITHUB_REPOSITORY: "example/cli", GITHUB_SHA: sha },
        stdout: "pipe", stderr: "pipe", timeout: 5000,
      });
      const read = () => { try { return readFileSync(calls, "utf8"); } catch { return ""; } };
      return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), calls: read() };
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  test("waits for CI and installation checks on the current main commit", () => {
    const result = fixture();
    expect(result.exitCode).toBe(0);
    expect(result.calls).toContain(`head_sha=${sha}`);
    expect(result.calls).toContain("workflows/ci.yml");
    expect(result.calls).toContain("workflows/install-smoke.yml");
    expect(result.stdout).toContain("install-smoke.yml: success");
  });

  for (const options of [{ failed: true }, { apiError: true }]) {
    test(`blocks the release for ${JSON.stringify(options)}`, () => {
      expect(fixture(options).exitCode).toBe(1);
    });
  }
});
