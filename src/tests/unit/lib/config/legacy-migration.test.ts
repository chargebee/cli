import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetKeychainForTest,
  __setKeychainForTest,
  type KeychainStore,
} from "../../../../lib/config/keychain.js";
import { cleanupLegacyOAuthTokens, loadProfile, migrateLegacyCredentials } from "../../../../lib/config/profiles.js";

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

describe("legacy credential migration", () => {
  let tmpDir: string;
  let store: ReturnType<typeof memoryStore>;

  afterEach(() => {
    __resetKeychainForTest();
    delete process.env.CHARGEBEE_CONFIG_DIR;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup() {
    tmpDir = mkdtempSync(join(tmpdir(), "cb-legacy-"));
    process.env.CHARGEBEE_CONFIG_DIR = tmpDir;
    store = memoryStore();
    __setKeychainForTest(store);
  }

  function writeLegacyProfile(name: string, data: Record<string, unknown>) {
    mkdirSync(join(tmpDir, "profiles"), { recursive: true });
    writeFileSync(join(tmpDir, "profiles", `${name}.json`), JSON.stringify(data));
  }

  it("loadProfile alone reads an inline key without migrating or touching the file", async () => {
    setup();
    writeLegacyProfile("old", { site: "acme", api_key: "live_legacy" });
    const before = readFileSync(join(tmpDir, "profiles", "old.json"), "utf-8");
    const loaded = await loadProfile("old");
    expect(loaded).toEqual({ site: "acme", api_key: "live_legacy" });
    expect(store.map.size).toBe(0);
    expect(readFileSync(join(tmpDir, "profiles", "old.json"), "utf-8")).toBe(before);
  });

  it("migrateLegacyCredentials moves an inline plaintext key into the keychain", async () => {
    setup();
    writeLegacyProfile("old", { site: "acme", api_key: "live_legacy" });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await migrateLegacyCredentials();
      const loaded = await loadProfile("old");
      expect(loaded).toEqual({ site: "acme", api_key_source: "keychain", api_key: "live_legacy" });
      expect(store.map.get("old")).toBe("live_legacy");
      const disk = JSON.parse(readFileSync(join(tmpDir, "profiles", "old.json"), "utf-8"));
      expect(disk.api_key).toBeUndefined();
      expect(disk.api_key_source).toBe("keychain");
      const messages = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(messages).toContain("old");
      expect(messages.toLowerCase()).toContain("migrat");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("leaves the key in the file and does not throw when the profile file cannot be rewritten", async () => {
    setup();
    writeLegacyProfile("ro", { site: "acme", api_key: "live_ro" });
    const file = join(tmpDir, "profiles", "ro.json");
    const profilesDir = join(tmpDir, "profiles");
    // The rewrite goes through a temp-file-then-rename, so it is the
    // directory's write permission (needed to create the temp file), not the
    // target file's own mode, that has to block it here.
    chmodSync(profilesDir, 0o500);
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await migrateLegacyCredentials();
      const loaded = await loadProfile("ro");
      expect(loaded).toEqual({ site: "acme", api_key: "live_ro" });
      const disk = JSON.parse(readFileSync(file, "utf-8"));
      expect(disk.api_key).toBe("live_ro");
      expect(disk.api_key_source).toBeUndefined();
      const messages = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(messages).toContain(file);
      expect(messages).not.toContain("Migrated");
    } finally {
      errSpy.mockRestore();
      chmodSync(profilesDir, 0o700);
    }
  });

  it("keeps the plaintext key when the keychain copy does not read back equal", async () => {
    setup();
    store.set = async (profile) => {
      store.map.set(profile, "not-the-key");
    };
    writeLegacyProfile("lie", { site: "acme", api_key: "live_real" });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await migrateLegacyCredentials();
      const first = await loadProfile("lie");
      expect(first?.api_key).toBe("live_real");
      const disk = JSON.parse(readFileSync(join(tmpDir, "profiles", "lie.json"), "utf-8"));
      expect(disk.api_key).toBe("live_real");
      expect(disk.api_key_source).toBeUndefined();
      expect(store.map.has("lie")).toBe(false);
      const second = await loadProfile("lie");
      expect(second?.api_key).toBe("live_real");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("removes legacy oauth2/tokens files this CLI wrote, leaving unrelated files alone", async () => {
    setup();
    const tokensDir = join(tmpDir, "oauth2", "tokens");
    mkdirSync(tokensDir, { recursive: true });
    writeFileSync(join(tokensDir, "acme-test.json"), JSON.stringify({ access_token: "test_legacy", refresh_token: "" }));
    writeFileSync(join(tokensDir, "unrelated.json"), JSON.stringify({ some: "thing" }));
    const removed = await cleanupLegacyOAuthTokens();
    expect(removed).toEqual(["acme-test.json"]);
    expect(existsSync(join(tokensDir, "acme-test.json"))).toBe(false);
    expect(existsSync(join(tokensDir, "unrelated.json"))).toBe(true);
  });

  it("does not migrate and does not touch oauth2/tokens when the keychain is unavailable", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cb-legacy-"));
    process.env.CHARGEBEE_CONFIG_DIR = tmpDir;
    __resetKeychainForTest(); // no injected store, CHARGEBEE_CONFIG_DIR forces file store
    writeLegacyProfile("old", { site: "acme", api_key: "live_legacy" });
    const tokensDir = join(tmpDir, "oauth2", "tokens");
    mkdirSync(tokensDir, { recursive: true });
    writeFileSync(join(tokensDir, "acme.json"), JSON.stringify({ access_token: "live_legacy", refresh_token: "" }));

    await migrateLegacyCredentials();
    const loaded = await loadProfile("old");
    expect(loaded).toEqual({ site: "acme", api_key: "live_legacy" });
    const disk = JSON.parse(readFileSync(join(tmpDir, "profiles", "old.json"), "utf-8"));
    expect(disk.api_key).toBe("live_legacy");
    expect(disk.api_key_source).toBeUndefined();
    expect(existsSync(join(tokensDir, "acme.json"))).toBe(true);
  });
});
