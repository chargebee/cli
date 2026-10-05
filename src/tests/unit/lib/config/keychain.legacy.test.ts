/**
 * Keychain account scoping for a non-default CHARGEBEE_CONFIG_DIR: reads that
 * miss the scoped account fall back to the unscoped `profile:<name>` item and
 * move it under the scoped account. Uses an in-memory account store.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopedKeychainStore, type KeychainAccountStore } from "../../../../lib/config/keychain.js";

function memoryAccountStore(): KeychainAccountStore & { map: Map<string, string>; calls: string[] } {
  const map = new Map<string, string>();
  const calls: string[] = [];
  return {
    map,
    calls,
    async get(account) {
      calls.push(`get ${account}`);
      return map.get(account) ?? null;
    },
    async set(account, secret) {
      calls.push(`set ${account}`);
      map.set(account, secret);
    },
    async delete(account) {
      calls.push(`delete ${account}`);
      map.delete(account);
    },
  };
}

describe("scoped keychain store", () => {
  const previousHome = process.env.HOME;
  const previousConfigDir = process.env.CHARGEBEE_CONFIG_DIR;
  let home: string;
  let customDir: string;
  let raw: ReturnType<typeof memoryAccountStore>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cb-kc-home-"));
    customDir = mkdtempSync(join(tmpdir(), "cb-kc-custom-"));
    process.env.HOME = home;
    process.env.CHARGEBEE_CONFIG_DIR = customDir;
    raw = memoryAccountStore();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousConfigDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = previousConfigDir;
    rmSync(home, { recursive: true, force: true });
    rmSync(customDir, { recursive: true, force: true });
  });

  function scopedAccount(): string {
    const scoped = [...raw.map.keys()].find((k) => /^profile:prod@[0-9a-f]{8}$/.test(k));
    if (!scoped) throw new Error(`no scoped account in ${[...raw.map.keys()].join(", ")}`);
    return scoped;
  }

  it("reads an item stored under the unscoped account and moves it under the scoped account", async () => {
    raw.map.set("profile:prod", "live_legacy");
    const store = scopedKeychainStore(raw);

    expect(await store.get("prod")).toBe("live_legacy");
    expect(raw.map.get(scopedAccount())).toBe("live_legacy");
    expect(raw.map.has("profile:prod")).toBe(false);

    raw.calls.length = 0;
    expect(await store.get("prod")).toBe("live_legacy");
    expect(raw.calls).toEqual([`get ${scopedAccount()}`]);
  });

  it("leaves the unscoped item alone when the scoped account already has an item", async () => {
    raw.map.set("profile:prod", "live_other");
    const store = scopedKeychainStore(raw);
    await store.set("prod", "live_scoped");

    expect(await store.get("prod")).toBe("live_scoped");
    expect(raw.map.get("profile:prod")).toBe("live_other");
    expect(raw.calls.filter((c) => c.startsWith("delete"))).toEqual([]);
  });

  it("returns null without touching the unscoped account when neither item exists", async () => {
    const store = scopedKeychainStore(raw);
    expect(await store.get("prod")).toBeNull();
    expect(raw.calls.filter((c) => c.startsWith("set") || c.startsWith("delete"))).toEqual([]);
  });

  it("keeps the unscoped item, and still returns it, when the scoped copy cannot be written", async () => {
    raw.map.set("profile:prod", "live_legacy");
    raw.set = async () => {
      throw new Error("denied");
    };
    const store = scopedKeychainStore(raw);
    expect(await store.get("prod")).toBe("live_legacy");
    expect(raw.map.get("profile:prod")).toBe("live_legacy");
  });

  it("keeps the unscoped item when the scoped copy does not read back", async () => {
    raw.map.set("profile:prod", "live_legacy");
    const realGet = raw.get.bind(raw);
    raw.get = async (account) => (account === "profile:prod" ? realGet(account) : null);
    const store = scopedKeychainStore(raw);
    expect(await store.get("prod")).toBe("live_legacy");
    expect(raw.map.get("profile:prod")).toBe("live_legacy");
    expect(raw.calls.filter((c) => c.startsWith("delete"))).toEqual([]);
  });

  it("delete removes the scoped and the unscoped item", async () => {
    raw.map.set("profile:prod", "live_legacy");
    const store = scopedKeychainStore(raw);
    await store.set("prod", "live_scoped");
    await store.delete("prod");
    expect(raw.map.size).toBe(0);
  });

  it("copies but never deletes the unscoped item when the default config dir has a profile of that name", async () => {
    mkdirSync(join(home, ".chargebee", "cli", "profiles"), { recursive: true });
    writeFileSync(join(home, ".chargebee", "cli", "profiles", "prod.json"), JSON.stringify({ site: "acme", api_key_source: "keychain" }));
    raw.map.set("profile:prod", "live_default");
    const store = scopedKeychainStore(raw);

    expect(await store.get("prod")).toBe("live_default");
    expect(raw.map.get(scopedAccount())).toBe("live_default");
    expect(raw.map.get("profile:prod")).toBe("live_default");

    await store.delete("prod");
    expect(raw.map.get("profile:prod")).toBe("live_default");
    expect([...raw.map.keys()]).toEqual(["profile:prod"]);
  });

  it("uses the unscoped account directly, with no fallback lookup, for the default config dir", async () => {
    delete process.env.CHARGEBEE_CONFIG_DIR;
    const store = scopedKeychainStore(raw);
    expect(await store.get("prod")).toBeNull();
    expect(raw.calls).toEqual(["get profile:prod"]);

    raw.calls.length = 0;
    await store.set("prod", "live_x");
    expect(await store.get("prod")).toBe("live_x");
    await store.delete("prod");
    expect(raw.calls).toEqual(["set profile:prod", "get profile:prod", "delete profile:prod"]);
  });
});
