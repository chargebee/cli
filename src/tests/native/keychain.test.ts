import { expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCli, writeDisabledTelemetry } from "../../lib/test-support/_spawn.js";
import { platformKeychain } from "../../lib/config/keychain.js";

// The workflow provisions an isolated store; never run against a developer's vault by default.
it.skipIf(process.env.CHARGEBEE_TEST_OS_KEYCHAIN !== "1")(
  "native credential store creates, replaces, reads, and deletes a disposable credential",
  async () => {
    const store = platformKeychain();
    if (!store) throw new Error(`No native credential store available on ${process.platform}`);
    const profile = `credential-smoke-${randomUUID()}`;
    try {
      expect(await store.get(profile)).toBeNull();
      await store.set(profile, "synthetic-secret");
      expect(await store.get(profile)).toBe("synthetic-secret");
      await store.set(profile, "synthetic-replacement");
      expect(await store.get(profile)).toBe("synthetic-replacement");
      await store.delete(profile);
      expect(await store.get(profile)).toBeNull();
      await store.delete(profile);
    } finally {
      await store.delete(profile);
    }
  },
  120_000,
);

it.skipIf(process.env.CHARGEBEE_TEST_OS_KEYCHAIN !== "1")(
  "compiled CLI reads, renames and removes a native credential-backed profile",
  async () => {
    const store = platformKeychain();
    if (!store) throw new Error("Native credential store unavailable");
    const dir = mkdtempSync(join(tmpdir(), "cb-native-profile-"));
    const previous = process.env.CHARGEBEE_CONFIG_DIR;
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    const name = `native-${randomUUID()}`;
    const renamed = `${name}-renamed`;
    writeDisabledTelemetry(dir);
    mkdirSync(join(dir, "profiles"));
    const cli = (args: string[], enabled = "1") => spawnCli(args, { configDir: dir, extraEnv: { CHARGEBEE_CLI_KEYCHAIN: enabled } });
    try {
      await store.set(name, "test_synthetic_secret");
      writeFileSync(join(dir, "profiles", `${name}.json`), JSON.stringify({ site: "cb-native-test", api_key_source: "keychain" }));
      const listed = await cli(["auth", "list"]);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain(name);
      expect(listed.stdout).not.toContain("unavailable");
      expect(listed.stdout).not.toContain("test_synthetic_secret");
      const disabled = await cli(["--use-profile", name, "customer", "list"], "0");
      expect(disabled.exitCode).toBe(1);
      expect(disabled.stderr).toContain("keychain is disabled");
      expect((await cli(["auth", "rename", name, renamed])).exitCode).toBe(0);
      expect(await store.get(name)).toBeNull();
      expect(await store.get(renamed)).toBe("test_synthetic_secret");
      const removed = await cli(["auth", "remove", renamed, "--yes"]);
      expect(removed.exitCode).toBe(0);
      expect(removed.stderr).not.toMatch(/may remain|cleanup was skipped/);
      expect(await store.get(renamed)).toBeNull();
    } finally {
      try { await store.delete(name); }
      finally {
        try { await store.delete(renamed); }
        finally {
          if (previous === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
          else process.env.CHARGEBEE_CONFIG_DIR = previous;
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  }, 180_000,
);
