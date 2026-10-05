/**
 * `auth add` / `auth switch` must never open a Clack prompt when stdin is
 * not a terminal (CI, agents, pipes). Real subprocesses with stdin closed, so
 * the pre-fix behaviour — hanging forever on the prompt — shows up as a timeout.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnCli, writeDisabledTelemetry } from "../../lib/test-support/_spawn.js";

async function withConfigDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "cb-non-tty-"));
  writeDisabledTelemetry(dir);
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedProfiles(dir: string): void {
  mkdirSync(join(dir, "profiles"), { recursive: true });
  writeFileSync(join(dir, "profiles", "dev.json"), JSON.stringify({ site: "acme-test", api_key: "test_x" }));
  writeFileSync(join(dir, "profiles", "prod.json"), JSON.stringify({ site: "acme", api_key: "live_x" }));
  writeFileSync(join(dir, "config"), "CHARGEBEE_DOMAIN=acme-test\nCHARGEBEE_ACTIVE_PROFILE=dev\n");
}

describe("auth add without a TTY (subprocess, stdin closed)", () => {
  it("auth add --site <site> exits 1 and names --api-key instead of prompting", async () => {
    const { stderr, exitCode } = await withConfigDir((configDir) =>
      spawnCli(["auth", "add", "--site", "acme-test"], { configDir }),
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--api-key");
    expect(stderr).toContain("CHARGEBEE_API_KEY");
  });

  it("auth add exits 1 and names --site and --api-key", async () => {
    const { stderr, exitCode } = await withConfigDir((configDir) =>
      spawnCli(["auth", "add"], { configDir }),
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--site");
    expect(stderr).toContain("--api-key");
    expect(stderr).toContain("--profile");
  });

  it("auth switch with saved profiles exits 1 and asks for a name", async () => {
    const { stderr, exitCode } = await withConfigDir((configDir) => {
      seedProfiles(configDir);
      return spawnCli(["auth", "switch"], { configDir });
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("chargebee auth switch <name>");
  });

  it("auth switch <name> still works without a TTY", async () => {
    const { stdout, exitCode } = await withConfigDir((configDir) => {
      seedProfiles(configDir);
      return spawnCli(["auth", "switch", "prod"], { configDir });
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Switched");
  });
});
