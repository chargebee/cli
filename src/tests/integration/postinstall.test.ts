/**
 * npm `postinstall` (scripts/postinstall.mjs): best-effort marker write for a
 * global install, skipped for local installs / --ignore-scripts / no HOME,
 * and never failing the install even when the write itself fails.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../../../scripts/postinstall.mjs");

function runPostinstall(env: Record<string, string | undefined>): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const fullEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...env })) {
    if (v !== undefined) fullEnv[k] = v;
  }
  const proc = Bun.spawnSync(["node", SCRIPT], { env: fullEnv, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe("postinstall", () => {
  it("writes the npm install-method marker under CHARGEBEE_CONFIG_DIR for a global install", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-postinstall-"));
    try {
      const result = runPostinstall({
        npm_config_global: "true",
        CHARGEBEE_CONFIG_DIR: dir,
        HOME: dir,
        npm_config_ignore_scripts: undefined,
      });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(join(dir, "install-method"), "utf8").trim()).toBe("npm");
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(result.stdout).toContain("chargebee skills add");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing for a local (non -g) install", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-postinstall-local-"));
    try {
      const result = runPostinstall({
        npm_config_global: "false",
        CHARGEBEE_CONFIG_DIR: dir,
        HOME: dir,
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dir, "install-method"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips the marker write when scripts are explicitly ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-postinstall-ignore-"));
    try {
      const result = runPostinstall({
        npm_config_global: "true",
        npm_config_ignore_scripts: "true",
        CHARGEBEE_CONFIG_DIR: dir,
        HOME: dir,
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dir, "install-method"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips the marker write when neither HOME nor USERPROFILE is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-postinstall-nohome-"));
    try {
      const result = runPostinstall({
        npm_config_global: "true",
        CHARGEBEE_CONFIG_DIR: dir,
        HOME: undefined,
        USERPROFILE: undefined,
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dir, "install-method"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never fails the install even if the marker write throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "cb-postinstall-fail-"));
    try {
      // Point CHARGEBEE_CONFIG_DIR at a path that cannot be created as a
      // directory (a plain file already occupies the parent segment).
      const blocker = join(dir, "blocker");
      mkdirSync(dir, { recursive: true });
      writeFileSync(blocker, "x");
      const result = runPostinstall({
        npm_config_global: "true",
        CHARGEBEE_CONFIG_DIR: join(blocker, "cli"),
        HOME: dir,
      });
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
