import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertValidProfileName,
  deleteProfile,
  listProfiles,
  loadProfile,
  profilePath,
  renameProfile,
  saveProfile,
} from "../../../../lib/config/profiles.js";

describe("profiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cb-test-"));
    process.env.CHARGEBEE_CONFIG_DIR = tmpDir;
  });

  afterEach(() => {
    delete process.env.CHARGEBEE_CONFIG_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves and loads a profile", async () => {
    await saveProfile("test", { site: "acme-test", api_key: "test_xxx" });
    const loaded = await loadProfile("test");
    expect(loaded).toEqual({ site: "acme-test", api_key: "test_xxx" });
  });

  it("returns null for a missing profile", async () => {
    expect(await loadProfile("nonexistent")).toBeNull();
  });

  it("lists profiles sorted alphabetically", async () => {
    await saveProfile("prod", { site: "acme", api_key: "live_xxx" });
    await saveProfile("test", { site: "acme-test", api_key: "test_xxx" });
    const profiles = await listProfiles();
    expect(profiles).toHaveLength(2);
    expect(profiles[0].name).toBe("prod");
    expect(profiles[0].data.site).toBe("acme");
    expect(profiles[1].name).toBe("test");
    expect(profiles[1].data.site).toBe("acme-test");
  });

  it("returns empty array when no profiles directory exists", async () => {
    expect(await listProfiles()).toEqual([]);
  });

  it("overwrites an existing profile on save", async () => {
    await saveProfile("test", { site: "acme-test", api_key: "old_key" });
    await saveProfile("test", { site: "acme-test", api_key: "new_key" });
    const loaded = await loadProfile("test");
    expect(loaded?.api_key).toBe("new_key");
  });

  it("deletes an existing profile and reports success", async () => {
    await saveProfile("test", { site: "acme-test", api_key: "test_xxx" });
    expect(await deleteProfile("test")).toBe(true);
    expect(await loadProfile("test")).toBeNull();
  });

  it("returns false when deleting a missing profile", async () => {
    expect(await deleteProfile("nonexistent")).toBe(false);
  });

  it("rejects invalid profile names", async () => {
    await expect(deleteProfile("../evil")).rejects.toThrow(/Invalid profile name/);
    await expect(renameProfile("a/b", "c")).rejects.toThrow(/Invalid profile name/);
  });

  it("renames a profile, preserving data and removing the old name", async () => {
    await saveProfile("old", { site: "acme-test", api_key: "test_xxx" });
    await renameProfile("old", "new");
    expect(await loadProfile("old")).toBeNull();
    expect(await loadProfile("new")).toEqual({ site: "acme-test", api_key: "test_xxx" });
  });

  it("throws when renaming a missing profile", async () => {
    await expect(renameProfile("ghost", "new")).rejects.toThrow(/not found/);
  });

  it("throws when the target name already exists", async () => {
    await saveProfile("a", { site: "a", api_key: "ka" });
    await saveProfile("b", { site: "b", api_key: "kb" });
    await expect(renameProfile("a", "b")).rejects.toThrow(/already exists/);
    // Source is untouched after a failed rename.
    expect(await loadProfile("a")).not.toBeNull();
  });

  it("is a no-op when old and new names are identical", async () => {
    await saveProfile("same", { site: "acme", api_key: "k" });
    await renameProfile("same", "same");
    expect(await loadProfile("same")).not.toBeNull();
  });

  it("saves a profile file at mode 0600", async () => {
    await saveProfile("test", { site: "acme-test", api_key: "test_xxx" });
    expect(statSync(profilePath("test")).mode & 0o777).toBe(0o600);
  });

  it("throws an actionable error when a profile file is corrupt JSON", async () => {
    mkdirSync(join(tmpDir, "profiles"), { recursive: true });
    writeFileSync(profilePath("broken"), "{not json");
    await expect(loadProfile("broken")).rejects.toThrow(
      /Profile file .*broken\.json is corrupt; re-run `chargebee auth add --profile broken`/,
    );
  });

  it("skips a profile file whose name is invalid in listProfiles with a stderr warning, keeping healthy ones", async () => {
    await saveProfile("good", { site: "acme-test", api_key: "test_xxx" });
    const oddFile = join(tmpDir, "profiles", "my profile.json");
    writeFileSync(oddFile, JSON.stringify({ site: "acme-test", api_key: "test_xxx" }));
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const profiles = await listProfiles();
      expect(profiles.map((p) => p.name)).toEqual(["good"]);
      const warning = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warning).toContain(oddFile);
      expect(warning).toContain("Rename the file");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("skips a corrupt profile in listProfiles with a stderr warning, keeping healthy ones", async () => {
    await saveProfile("good", { site: "acme-test", api_key: "test_xxx" });
    writeFileSync(profilePath("broken"), "{not json");
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const profiles = await listProfiles();
      expect(profiles.map((p) => p.name)).toEqual(["good"]);
      const warning = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warning).toContain(profilePath("broken"));
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("assertValidProfileName", () => {
  for (const ok of ["default", "prod", "a", "acme-test", "acme.test", "acme_test", "A1", "my.profile", "console", "x".repeat(64)]) {
    it(`accepts "${ok}"`, () => {
      expect(assertValidProfileName(ok)).toBe(ok);
    });
  }

  for (const bad of [
    "",
    ".",
    "..",
    "-leading",
    "_leading",
    ".leading",
    "a/b",
    "a\\b",
    'a"b',
    "a\nb",
    "a b",
    "a=b",
    "x".repeat(65),
    "CON",
    "con",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "com9",
    "LPT1",
    "lpt9",
    "con.prod",
    "Nul.json",
  ]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => assertValidProfileName(bad)).toThrow(/Invalid profile name/);
    });
  }
});
