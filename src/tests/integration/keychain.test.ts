/**
 * Keychain-backed profiles whose secret cannot be read — in-process CLI runs
 * against an injected store. Nothing here touches the real OS keychain.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetKeychainForTest,
  __setKeychainForTest,
  type KeychainStore,
} from "../../lib/config/keychain.js";
import {
  createEnvPatcher,
  installFakeClient,
  runCli,
  setStdinIsTTY,
  uninstallFakeClient,
  type ClientConstruction,
} from "../../lib/test-support/_helpers.js";

const SITE = "acme";
const KEY = "live_secret";

let configDir: string;
let constructions: ClientConstruction[];
let store: KeychainStore & { map: Map<string, string> };
let restoreStdin: (() => void) | undefined;
const env = createEnvPatcher();

function memoryStore(): KeychainStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async get(profile) {
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

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "cb-kc-cli-"));
  env.set("CHARGEBEE_CONFIG_DIR", configDir);
  env.set("CHARGEBEE_SITE", undefined);
  env.set("CHARGEBEE_API_KEY", undefined);
  env.set("CHARGEBEE_CLI_KEYCHAIN", undefined);
  constructions = [];
  installFakeClient({ constructions });
  restoreStdin = setStdinIsTTY(false);
  store = memoryStore();
  __setKeychainForTest(store);
  const saved = await runCli(["auth", "add", "--profile", "prod", "--site", SITE, "--api-key", KEY]);
  expect(saved.exitCode).toBe(0);
  expect(store.map.get("prod")).toBe(KEY);
  constructions.length = 0;
});

afterEach(() => {
  __resetKeychainForTest();
  restoreStdin?.();
  uninstallFakeClient();
  env.restore();
  rmSync(configDir, { recursive: true, force: true });
});

describe("keychain unavailable", () => {
  it("auth status reports the keychain problem instead of Connected", async () => {
    store.get = async () => {
      throw new Error("User interaction is not allowed.");
    };
    const { stdout, stderr, exitCode } = await runCli(["auth", "status"]);
    expect(exitCode).toBe(1);
    expect(stdout).not.toContain("Connected");
    expect(stderr).toContain('profile "prod"');
    expect(stderr).toContain("User interaction is not allowed.");
    expect(stderr).toContain("chargebee auth add --profile prod");
  });

  it("whoami reports the keychain problem", async () => {
    store.get = async () => null;
    const { stdout, stderr, exitCode } = await runCli(["whoami"]);
    expect(exitCode).toBe(1);
    expect(stdout).not.toContain("Connected");
    expect(stderr).toMatch(/keychain/i);
  });

  it("API commands fail with the keychain message, not 'Invalid API key'", async () => {
    store.get = async () => {
      throw new Error("keychain locked");
    };
    const { stderr, exitCode } = await runCli(["customer", "list"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("keychain locked");
    expect(stderr).not.toContain("Invalid API key");
    expect(constructions).toHaveLength(0);
  });

  it("auth rename refuses and leaves the key in place", async () => {
    store.get = async () => null;
    const deleted: string[] = [];
    store.delete = async (p) => {
      deleted.push(p);
    };
    const { stderr, exitCode } = await runCli(["auth", "rename", "prod", "live"]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/keychain/i);
    expect(deleted).toEqual([]);
    expect(store.map.get("prod")).toBe(KEY);
  });

  it("auth list still shows the profile and marks its key unavailable", async () => {
    store.get = async () => null;
    const { stdout, exitCode } = await runCli(["auth", "list"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("prod");
    expect(stdout).toContain(SITE);
    expect(stdout).toMatch(/unavailable/i);
  });
});

describe("storage backend visibility", () => {
  it("auth list shows the STORE column as keychain", async () => {
    const { stdout } = await runCli(["auth", "list"]);
    expect(stdout).toContain("STORE");
    expect(stdout).toMatch(/prod\s+acme\s+us\s+chargebee\.com\s+\S+\s+\S+\s+keychain/);
  });

  it("auth status shows the OS keychain backend", async () => {
    const { stdout } = await runCli(["auth", "status"]);
    expect(stdout).toContain("Key storage : OS keychain");
  });
});

describe("legacy credential migration runs from configure", () => {
  function seedLegacy() {
    writeFileSync(join(configDir, "profiles", "old.json"), JSON.stringify({ site: "acme-test", api_key: "test_inline" }));
    const tokensDir = join(configDir, "oauth2", "tokens");
    mkdirSync(tokensDir, { recursive: true });
    writeFileSync(join(tokensDir, "acme.json"), JSON.stringify({ access_token: "live_beta", refresh_token: "", expires_at: 0 }));
    return { tokenFile: join(tokensDir, "acme.json"), oldFile: join(configDir, "profiles", "old.json") };
  }

  it("an ordinary command leaves inline keys and oauth2/tokens alone", async () => {
    const { tokenFile, oldFile } = seedLegacy();
    const { exitCode } = await runCli(["customer", "list"]);
    expect(exitCode).toBe(0);
    expect(existsSync(tokenFile)).toBe(true);
    expect(JSON.parse(readFileSync(oldFile, "utf-8")).api_key).toBe("test_inline");
    expect(store.map.has("old")).toBe(false);
  });

  it("configure migrates other inline profiles and removes oauth2/tokens files", async () => {
    const { tokenFile, oldFile } = seedLegacy();
    const { stderr, exitCode } = await runCli(["auth", "add", "--profile", "second", "--site", SITE, "--api-key", KEY]);
    expect(exitCode).toBe(0);
    expect(existsSync(tokenFile)).toBe(false);
    expect(existsSync(join(configDir, "oauth2"))).toBe(false);
    expect(store.map.get("old")).toBe("test_inline");
    const disk = JSON.parse(readFileSync(oldFile, "utf-8"));
    expect(disk.api_key).toBeUndefined();
    expect(disk.api_key_source).toBe("keychain");
    expect(stderr).toContain("oauth2/tokens/acme.json");
    expect(stderr).toContain('profile "old"');
  });

  it("auth status migrates too", async () => {
    const { tokenFile, oldFile } = seedLegacy();
    const { exitCode } = await runCli(["auth", "status"]);
    expect(exitCode).toBe(0);
    expect(existsSync(tokenFile)).toBe(false);
    expect(JSON.parse(readFileSync(oldFile, "utf-8")).api_key_source).toBe("keychain");
  });
});
