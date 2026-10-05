import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const scripts = join(import.meta.dir, "../../../scripts");
const spec = "@example/cli@1.2.3-beta.4";
const version = "1.2.3-beta.4";

describe.skipIf(process.platform === "win32")("npm registry readiness", () => {
  function run(responses: Array<{ status?: number; stdout?: unknown; stderr?: string; raw?: string }>, mode = "version", extraEnv = {}, packageSpec = spec) {
    const root = mkdtempSync(join(tmpdir(), "cb-npm-ready-"));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      const log = join(root, "calls.json");
      const stub = join(bin, "npm");
      // A subprocess double: no registry connection or real npm config.
      writeFileSync(stub, `#!${process.execPath}
import {readFileSync, writeFileSync} from "node:fs";
let calls = []; try { calls = JSON.parse(readFileSync(${JSON.stringify(log)}, "utf8")); } catch {}
const responses = ${JSON.stringify(responses)};
const response = responses[Math.min(calls.length, responses.length - 1)];
calls.push({args: process.argv.slice(2), token: process.env.NODE_AUTH_TOKEN});
writeFileSync(${JSON.stringify(log)}, JSON.stringify(calls));
process.stdout.write(response.raw ?? JSON.stringify(response.stdout ?? {}));
process.stderr.write(response.stderr ?? "");
process.exit(response.status ?? 0);
`);
      chmodSync(stub, 0o755);
      const proc = Bun.spawnSync(["node", join(scripts, "wait-for-npm-release.mjs"), packageSpec, mode], {
        env: {
          PATH: `${bin}:${dirname(Bun.which("node")!)}:/usr/bin:/bin`,
          NODE_AUTH_TOKEN: "fixture-token",
          NPM_RELEASE_ATTEMPTS: "3",
          NPM_RELEASE_DELAY_MS: "0",
          ...extraEnv,
        },
        stdout: "pipe", stderr: "pipe", timeout: 10_000,
      });
      let calls = [];
      try { calls = JSON.parse(readFileSync(log, "utf8")); } catch {}
      return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), calls };
    } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it("waits through missing versions and forwards npm authentication", () => {
    const result = run([
      { status: 1, stderr: "npm error ETARGET" },
      { status: 1, stderr: "npm error E404" },
      { stdout: version },
    ]);
    expect(result.code).toBe(0);
    expect(result.calls).toHaveLength(3);
    expect(result.calls[0].token).toBe("fixture-token");
    expect(result.calls[0].args).toContain(spec);
    expect(result.calls[0].args.slice(0, 2)).toEqual(["cache", "add"]);
    expect(result.calls[0].args).toContain("--ignore-scripts");
    expect(result.calls[0].args).toContain("--prefer-online");
    expect(result.stdout).toContain("Verified npm version");
  });

  for (const code of ["E401", "E403", "ENEEDAUTH", "EOTP"]) {
    it(`fails immediately on ${code} without exposing npm diagnostics`, () => {
      const result = run([{ status: 1, stderr: `npm error ${code} https://private.example/secret` }]);
      expect(result.code).toBe(1);
      expect(result.calls).toHaveLength(1);
      expect(result.stderr).toContain("authentication/access failed");
      expect(result.stderr).not.toContain("private.example");
    });
  }

  it("fails after the retry budget with a private-package diagnostic", () => {
    const result = run([{ status: 1, stderr: "npm error E404" }]);
    expect(result.code).toBe(1);
    expect(result.calls).toHaveLength(3);
    expect(result.stderr).toContain("private package is inaccessible");
  });

  it("rejects stale versions and malformed metadata", () => {
    const result = run([
      { stdout: { version: "1.2.3-beta.3", readme: "# Old" } },
      { raw: "not JSON" },
      { stdout: { version, readme: "# CLI" } },
    ], "readme");
    expect(result.code).toBe(0);
    expect(result.calls).toHaveLength(3);
  });

  it("waits for README metadata even after the version appears", () => {
    const result = run([
      { stdout: { version } },
      { stdout: { version, readme: "ERROR: No README data found!" } },
      { stdout: { version, readme: "# CLI\nInstallation instructions" } },
    ], "readme");
    expect(result.code).toBe(0);
    expect(result.calls).toHaveLength(3);
    expect(result.calls[0].args).toContain("readme");
    expect(result.stdout).toContain("Verified npm readme");
  });

  it("fails when README metadata remains empty", () => {
    const result = run([{ stdout: { version, readme: "   " } }], "readme");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("README metadata is missing");
    expect(result.stderr).toContain("although the version is published");
    expect(result.stderr).not.toContain("Check registry availability and token read access");
  });

  it("recognizes a published version when npm omits the requested README field", () => {
    const result = run([{ stdout: version }], "readme");
    expect(result.code).toBe(1);
    expect(result.calls).toHaveLength(3);
    expect(result.stderr).toContain("README metadata is missing");
    expect(result.stderr).not.toContain("exact version is not visible");
  });

  it("does not treat missing README metadata as a publication failure", () => {
    const result = run([{ stdout: { version, readme: "" } }], "readme");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Do not republish the same version");
    expect(result.calls.every((call: any) => call.args[0] === "view")).toBe(true);
  });

  it("rejects invalid polling configuration without invoking npm", () => {
    const result = run([], "version", { NPM_RELEASE_ATTEMPTS: "0" });
    expect(result.code).toBe(1);
    expect(result.calls).toHaveLength(0);
  });

  for (const packageSpec of ["@example/cli@latest", "./package@1.2.3", "1.2.3", "https://example.com/package@1.2.3"]) {
    it(`rejects a non-exact registry spec: ${packageSpec}`, () => {
      const result = run([], "version", {}, packageSpec);
      expect(result.code).toBe(1);
      expect(result.calls).toHaveLength(0);
      expect(result.stderr).toContain("package@exact-version");
    });
  }
});

describe("npm package contents", () => {
  function check(files: Array<{ path: string; size: number }>, readme = "# CLI", packedVersion = version) {
    const root = mkdtempSync(join(tmpdir(), "cb-npm-pack-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@example/cli", version, bin: { chargebee: "dist/index.js" } }));
      writeFileSync(join(root, "README.md"), readme);
      const proc = Bun.spawnSync(["node", join(scripts, "check-npm-package.mjs")], {
        cwd: root,
        stdin: Buffer.from(JSON.stringify([{ name: "@example/cli", version: packedVersion, files }])),
        stdout: "pipe", stderr: "pipe",
      });
      return { code: proc.exitCode, stderr: proc.stderr.toString() };
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  const files = [{ path: "README.md", size: 42 }, { path: "dist/index.js", size: 100 }];
  it("accepts a built package with a README", () => { expect(check(files).code).toBe(0); });
  it("rejects an unpackaged README", () => { expect(check(files.slice(1)).stderr).toContain("Missing or empty package file: README.md"); });
  it("rejects an unpackaged binary", () => { expect(check(files.slice(0, 1)).code).toBe(1); });
  it("rejects an empty README", () => { expect(check(files, "  ").code).toBe(1); });
  it("rejects an empty README in the tarball even when the local README is valid", () => {
    expect(check([{ path: "README.md", size: 0 }, files[1]]).stderr).toContain("Missing or empty package file: README.md");
  });
  it("rejects a version mismatch", () => { expect(check(files, "# CLI", "1.0.0").code).toBe(1); });
});
