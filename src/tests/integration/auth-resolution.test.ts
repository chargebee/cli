/**
 * A write command calls both `ensureWriteAllowed` and `getClient`, which each
 * need the resolved site/API key. resolveAuth caches its result for the life
 * of the command, so a keychain-backed profile is read from the OS keychain
 * once per command, not once per caller. Nothing here touches the real OS
 * keychain — the store is injected.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetKeychainForTest, __setKeychainForTest, type KeychainStore } from "../../lib/config/keychain.js";
import {
  createEnvPatcher,
  installFakeClient,
  runCli,
  setStdinIsTTY,
  uninstallFakeClient,
  type ClientConstruction,
} from "../../lib/test-support/_helpers.js";

const SITE = "acme-test";
const KEY = "test_secret";

function countingStore(): KeychainStore & { getCalls: string[] } {
  const map = new Map<string, string>();
  const getCalls: string[] = [];
  return {
    getCalls,
    async get(profile) {
      getCalls.push(profile);
      return map.get(profile) ?? null;
    },
    async set(profile, secret) {
      map.set(profile, secret);
    },
    async delete(profile) {
      map.delete(profile);
    },
  };
}

describe("auth resolution is cached per command", () => {
  let configDir: string;
  let constructions: ClientConstruction[];
  let store: ReturnType<typeof countingStore>;
  let restoreStdin: (() => void) | undefined;
  const env = createEnvPatcher();

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "cb-auth-once-"));
    env.set("CHARGEBEE_CONFIG_DIR", configDir);
    env.set("CHARGEBEE_SITE", undefined);
    env.set("CHARGEBEE_API_KEY", undefined);
    constructions = [];
    installFakeClient({ constructions });
    restoreStdin = setStdinIsTTY(false);
    store = countingStore();
    __setKeychainForTest(store);
    const saved = await runCli(["auth", "add", "--profile", "prod", "--site", SITE, "--api-key", KEY]);
    expect(saved.exitCode).toBe(0);
    store.getCalls.length = 0;
    constructions.length = 0;
  });

  afterEach(() => {
    __resetKeychainForTest();
    restoreStdin?.();
    uninstallFakeClient();
    env.restore();
    rmSync(configDir, { recursive: true, force: true });
  });

  it("reads the keychain-backed profile once for a write command", async () => {
    const { exitCode } = await runCli(["customer", "create"]);
    expect(exitCode).toBe(0);
    expect(constructions).toHaveLength(1);
    expect(store.getCalls).toHaveLength(1);
  });

  it("reads the keychain-backed profile once for a read command", async () => {
    const { exitCode } = await runCli(["customer", "list"]);
    expect(exitCode).toBe(0);
    expect(store.getCalls).toHaveLength(1);
  });
});
