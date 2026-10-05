import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetKeychainForTest,
  __setKeychainForTest,
  KeychainUnavailableError,
  type KeychainStore,
} from "../../../../lib/config/keychain.js";
import { deleteProfile, loadProfile, renameProfile, saveProfile } from "../../../../lib/config/profiles.js";

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

describe("profiles + keychain", () => {
  let tmpDir: string;
  let store: ReturnType<typeof memoryStore>;

  afterEach(() => {
    __resetKeychainForTest();
    delete process.env.CHARGEBEE_CONFIG_DIR;
    delete process.env.CHARGEBEE_CLI_KEYCHAIN;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), "cb-kc-"));
    process.env.CHARGEBEE_CONFIG_DIR = tmpDir;
    store = memoryStore();
    __setKeychainForTest(store);
  }

  function blockProfileWrite(name: string): () => void {
    const path = join(tmpDir, "profiles", `${name}.json`);
    const backup = `${path}.saved`;
    const existed = existsSync(path);
    if (existed) renameSync(path, backup);
    mkdirSync(path);
    return () => {
      rmSync(path, { recursive: true, force: true });
      if (existed) renameSync(backup, path);
    };
  }

  for (const { kind, site, api_key } of [
    { kind: "test_", site: "acme-test", api_key: "test_secret" },
    { kind: "live_", site: "acme", api_key: "live_secret" },
  ]) {
    it(`stores ${kind} keys in the keychain and omits them from JSON`, async () => {
      setup();
      await saveProfile("prod", { site, api_key });
      expect(store.map.get("prod")).toBe(api_key);
      const disk = JSON.parse(readFileSync(join(tmpDir, "profiles", "prod.json"), "utf-8"));
      expect(disk.api_key).toBeUndefined();
      expect(disk.api_key_source).toBe("keychain");
      expect(disk.site).toBe(site);
      expect(await loadProfile("prod")).toEqual({
        site,
        api_key,
        api_key_source: "keychain",
      });
    });
  }

  it("falls back to the file when the keychain write fails, warning on stderr", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cb-kc-"));
    process.env.CHARGEBEE_CONFIG_DIR = tmpDir;
    __setKeychainForTest({
      async get() {
        return null;
      },
      async set() {
        throw new Error("denied");
      },
      async delete() {},
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await saveProfile("qa", { site: "acme-test", api_key: "test_secret" });
      expect(result).toEqual({ backend: "file", reason: "the OS keychain write failed" });
      const disk = JSON.parse(readFileSync(join(tmpDir, "profiles", "qa.json"), "utf-8"));
      expect(disk.api_key).toBe("test_secret");
      expect(disk.api_key_source).toBe("file");
      const warning = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warning).toContain(join(tmpDir, "profiles", "qa.json"));
      expect(warning).toContain("chargebee auth add --profile qa");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("leaves keys in the file when keychain is off (CHARGEBEE_CONFIG_DIR)", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cb-kc-"));
    process.env.CHARGEBEE_CONFIG_DIR = tmpDir;
    __resetKeychainForTest();
    await saveProfile("qa", { site: "acme-test", api_key: "test_secret" });
    const disk = JSON.parse(readFileSync(join(tmpDir, "profiles", "qa.json"), "utf-8"));
    expect(disk.api_key).toBe("test_secret");
  });

  it("moves the keychain item on rename and deletes it on remove", async () => {
    setup();
    await saveProfile("old", { site: "acme-test", api_key: "test_secret" });
    await renameProfile("old", "new");
    expect(store.map.get("old")).toBeUndefined();
    expect(store.map.get("new")).toBe("test_secret");
    expect(await loadProfile("old")).toBeNull();
    expect((await loadProfile("new"))?.api_key).toBe("test_secret");
    expect(await deleteProfile("new")).toBe(true);
    expect(store.map.get("new")).toBeUndefined();
  });

  it("warns when profile removal leaves an OS credential, including on retry", async () => {
    setup();
    await saveProfile("prod", { site: "acme-test", api_key: "test_secret" });
    store.delete = async () => { throw new Error("sensitive backend details"); };
    const warning = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await deleteProfile("prod")).toBe(true);
      expect(await loadProfile("prod")).toBeNull();
      expect(store.map.has("prod")).toBe(true);
      expect(await deleteProfile("prod")).toBe(false);
      expect(warning).toHaveBeenCalledTimes(2);
      expect(String(warning.mock.calls[0])).toContain("API key may remain");
      expect(String(warning.mock.calls[0])).not.toContain("sensitive backend details");
    } finally { warning.mockRestore(); }
  });

  it("warns if credential cleanup is disabled for a keychain-backed profile", async () => {
    setup();
    await saveProfile("prod", { site: "acme-test", api_key: "test_secret" });
    process.env.CHARGEBEE_CLI_KEYCHAIN = "0";
    const warning = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await deleteProfile("prod")).toBe(true);
      expect(String(warning.mock.calls[0])).toContain("cleanup was skipped");
      expect(store.map.has("prod")).toBe(true);
    } finally { warning.mockRestore(); }
  });

  it("replaces the keychain item when a live profile is overwritten with a test key", async () => {
    setup();
    await saveProfile("mixed", { site: "acme", api_key: "live_secret" });
    await saveProfile("mixed", { site: "acme-test", api_key: "test_secret" });
    expect(store.map.get("mixed")).toBe("test_secret");
    const disk = JSON.parse(readFileSync(join(tmpDir, "profiles", "mixed.json"), "utf-8"));
    expect(disk.api_key).toBeUndefined();
    expect(disk.api_key_source).toBe("keychain");
    expect((await loadProfile("mixed"))?.api_key).toBe("test_secret");
  });

  it("re-saves a profile whose previous keychain item is missing", async () => {
    setup();
    await saveProfile("prod", { site: "old-site", api_key: "old_key" });
    store.map.delete("prod");
    const result = await saveProfile("prod", { site: "new-site", api_key: "new_key" });
    expect(result.backend).toBe("keychain");
    expect(await loadProfile("prod")).toEqual({ site: "new-site", api_key: "new_key", api_key_source: "keychain" });
  });

  it("saves to the file when the previous keychain item cannot be read", async () => {
    setup();
    await saveProfile("prod", { site: "old-site", api_key: "old_key" });
    store.get = async () => { throw new Error("locked"); };
    const result = await saveProfile("prod", { site: "new-site", api_key: "new_key" });
    expect(result).toEqual({ backend: "file", reason: "the OS keychain could not be read" });
    const disk = JSON.parse(readFileSync(join(tmpDir, "profiles", "prod.json"), "utf-8"));
    expect(disk.api_key).toBe("new_key");
    expect(disk.api_key_source).toBe("file");
  });

  it("keeps the old credential when the keychain and profile file writes fail", async () => {
    setup();
    await saveProfile("prod", { site: "old-site", api_key: "old_key" });
    let restoreFile: (() => void) | undefined;
    let deletes = 0;
    store.set = async () => {
      restoreFile = blockProfileWrite("prod");
      throw new Error("keychain denied");
    };
    store.delete = async () => { deletes++; };
    try {
      await expect(saveProfile("prod", { site: "new-site", api_key: "new_key" })).rejects.toThrow();
    } finally {
      restoreFile?.();
    }
    expect(deletes).toBe(0);
    expect(store.map.get("prod")).toBe("old_key");
    expect((await loadProfile("prod"))?.site).toBe("old-site");
    expect((await loadProfile("prod"))?.api_key).toBe("old_key");
  });

  it("restores an overwritten key when the profile file write fails", async () => {
    setup();
    await saveProfile("prod", { site: "old-site", api_key: "old_key" });
    const originalSet = store.set.bind(store);
    let restoreFile: (() => void) | undefined;
    store.set = async (profile, secret) => {
      await originalSet(profile, secret);
      if (secret === "new_key") restoreFile = blockProfileWrite("prod");
    };
    try {
      await expect(saveProfile("prod", { site: "new-site", api_key: "new_key" })).rejects.toThrow();
    } finally {
      restoreFile?.();
    }
    expect(store.map.get("prod")).toBe("old_key");
    expect(await loadProfile("prod")).toEqual({ site: "old-site", api_key: "old_key", api_key_source: "keychain" });
  });

  it("removes a new keychain item when its profile file write fails", async () => {
    setup();
    const originalSet = store.set.bind(store);
    let restoreFile: (() => void) | undefined;
    store.set = async (profile, secret) => {
      await originalSet(profile, secret);
      restoreFile = blockProfileWrite("new");
    };
    try {
      await expect(saveProfile("new", { site: "new-site", api_key: "new_key" })).rejects.toThrow();
    } finally {
      restoreFile?.();
    }
    expect(store.map.has("new")).toBe(false);
    expect(await loadProfile("new")).toBeNull();
  });

  it("throws KeychainUnavailableError when the store returns null for a keychain-backed profile", async () => {
    setup();
    await saveProfile("prod", { site: "acme", api_key: "live_secret" });
    store.map.clear(); // item vanished (deleted by the user, different login keychain, …)
    const err = await loadProfile("prod").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeychainUnavailableError);
    expect((err as Error).message).toContain('profile "prod"');
    expect((err as Error).message).toContain("chargebee auth add --profile prod");
  });

  it("throws KeychainUnavailableError with the store error when the read throws", async () => {
    setup();
    await saveProfile("prod", { site: "acme", api_key: "live_secret" });
    store.get = async () => {
      throw new Error("User interaction is not allowed.");
    };
    const err = await loadProfile("prod").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeychainUnavailableError);
    expect((err as Error).message).toContain("User interaction is not allowed.");
    expect((err as Error).message).toContain("chargebee auth add --profile prod");
    expect((err as Error).message).toContain("CHARGEBEE_CONFIG_DIR");
  });

  it("explains when the keychain is disabled after the key was stored there", async () => {
    setup();
    await saveProfile("prod", { site: "acme", api_key: "live_secret" });
    process.env.CHARGEBEE_CLI_KEYCHAIN = "0";
    const err = await loadProfile("prod").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeychainUnavailableError);
    expect((err as Error).message).toContain("CHARGEBEE_CLI_KEYCHAIN");
  });

  it("still loads a file-stored key when the keychain is disabled", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cb-kc-"));
    process.env.CHARGEBEE_CONFIG_DIR = tmpDir;
    __resetKeychainForTest();
    await saveProfile("qa", { site: "acme-test", api_key: "test_secret" });
    expect((await loadProfile("qa"))?.api_key).toBe("test_secret");
  });

  it("rename aborts without touching anything when the key cannot be read", async () => {
    setup();
    await saveProfile("old", { site: "acme", api_key: "live_secret" });
    const deleted: string[] = [];
    const sets: string[] = [];
    store.get = async () => {
      throw new Error("keychain locked");
    };
    store.set = async (profile) => {
      sets.push(profile);
    };
    store.delete = async (profile) => {
      deleted.push(profile);
    };
    await expect(renameProfile("old", "new")).rejects.toBeInstanceOf(KeychainUnavailableError);
    expect(sets).toEqual([]);
    expect(deleted).toEqual([]);
    expect(store.map.get("old")).toBe("live_secret");
    expect(existsSync(join(tmpDir, "profiles", "old.json"))).toBe(true);
    expect(existsSync(join(tmpDir, "profiles", "new.json"))).toBe(false);
  });

  it("rename aborts when the store returns null and never writes an empty key", async () => {
    setup();
    await saveProfile("old", { site: "acme", api_key: "live_secret" });
    const deleted: string[] = [];
    store.get = async () => null;
    store.delete = async (profile) => {
      deleted.push(profile);
    };
    await expect(renameProfile("old", "new")).rejects.toBeInstanceOf(KeychainUnavailableError);
    expect(deleted).toEqual([]);
    expect(existsSync(join(tmpDir, "profiles", "old.json"))).toBe(true);
    expect(existsSync(join(tmpDir, "profiles", "new.json"))).toBe(false);
  });

  it("rename keeps the source when the destination cannot be read back", async () => {
    setup();
    await saveProfile("old", { site: "acme", api_key: "live_secret" });
    const deleted: string[] = [];
    const realGet = store.get.bind(store);
    store.get = async (profile) => (profile === "new" ? null : realGet(profile));
    store.delete = async (profile) => {
      deleted.push(profile);
    };
    await expect(renameProfile("old", "new")).rejects.toThrow(/could not be read back|keychain/i);
    expect(deleted).not.toContain("old");
    expect(store.map.get("old")).toBe("live_secret");
    expect(existsSync(join(tmpDir, "profiles", "old.json"))).toBe(true);
    expect((await loadProfile("old"))?.api_key).toBe("live_secret");
  });

  it("saveProfile refuses an empty API key", async () => {
    setup();
    await expect(saveProfile("empty", { site: "acme", api_key: "" })).rejects.toThrow(/API key/);
    expect(existsSync(join(tmpDir, "profiles", "empty.json"))).toBe(false);
  });
});
