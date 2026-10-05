/**
 * Subprocess checks for `src/index.ts` (fatal handlers, `runProgram`, `--help`).
 * In-process `runCli` swallows `process.exit`, so it cannot prove no Bun stack.
 *
 * Default: `bun src/index.ts`. Set `CHARGEBEE_CLI_BINARY` to spawn a compiled
 * artifact instead (live tests use the same helper).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  spawnCli,
  writeDisabledTelemetry,
} from "../../lib/test-support/_spawn.js";

/** Quiet telemetry via persisted disable (the only supported opt-out). */
async function runIndex(args: string[]) {
  const configDir = mkdtempSync(join(tmpdir(), "cb-cli-errors-"));
  writeDisabledTelemetry(configDir);
  try {
    return await spawnCli(args, { configDir });
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

function looksLikeAStack(text: string): boolean {
  return (
    /\s+at\s+\S+/.test(text) ||
    /\.(ts|js):\d+:\d+/.test(text) ||
    text.includes("Bun v")
  );
}

describe("CLI process (subprocess)", () => {
  it("--version reports the package.json version", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "cb-cli-version-"));
    writeDisabledTelemetry(configDir);
    try {
      const { stdout, stderr, exitCode } = await spawnCli(["--version"], {
        configDir,
        extraEnv: { VERSION: "" },
      });
      expect(exitCode).toBe(0);
      const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf8"));
      expect(stdout).toBe(pkg.version);
      expect(looksLikeAStack(stderr)).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("--version strips a leading v from a release-tag VERSION (compiled-binary build)", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "cb-cli-version-tag-"));
    writeDisabledTelemetry(configDir);
    try {
      const { stdout, exitCode } = await spawnCli(["--version"], {
        configDir,
        extraEnv: { VERSION: "v1.2.3" },
      });
      expect(exitCode).toBe(0);
      const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../../../package.json"), "utf8"));
      expect(stdout).toBe(process.env.CHARGEBEE_CLI_BINARY ? pkg.version : "1.2.3");
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("--help exits 0 and prints USAGE", async () => {
    const { stdout, stderr, exitCode } = await runIndex(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
    expect(looksLikeAStack(stdout)).toBe(false);
    expect(looksLikeAStack(stderr)).toBe(false);
  });

  it("open unknown shortcut prints the message without a runtime stack", async () => {
    const { stderr, stdout, exitCode } = await runIndex([
      "open",
      "not-a-real-shortcut",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown shortcut");
    expect(looksLikeAStack(stderr)).toBe(false);
    expect(looksLikeAStack(stdout)).toBe(false);
  });

  it("unknown command stays a one-liner plus --help, no stack", async () => {
    const { stderr, exitCode } = await runIndex(["foobarbaz"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown command");
    expect(stderr).toContain("--help");
    expect(looksLikeAStack(stderr)).toBe(false);
  });
});
