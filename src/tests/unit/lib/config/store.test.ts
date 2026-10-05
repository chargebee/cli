import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { configDir, peekActiveSiteSync, readConfig, writeConfig } from "../../../../lib/config/store.js";

describe("config store", () => {
  const previousConfigDir = process.env.CHARGEBEE_CONFIG_DIR;
  const previousHome = process.env.HOME;
  const previousSite = process.env.CHARGEBEE_SITE;
  const previousKey = process.env.CHARGEBEE_API_KEY;
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (previousConfigDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = previousConfigDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSite === undefined) delete process.env.CHARGEBEE_SITE;
    else process.env.CHARGEBEE_SITE = previousSite;
    if (previousKey === undefined) delete process.env.CHARGEBEE_API_KEY;
    else process.env.CHARGEBEE_API_KEY = previousKey;
  });

  it("merges partial writes with existing config values", async () => {
    dir = mkdtempSync(join(tmpdir(), "cb-config-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;

    await writeConfig({
      domain: "first-test",
      activeProfile: "dev",
    });
    await writeConfig({ domain: "second-test" });

    const cfg = await readConfig();
    expect(cfg.domain).toBe("second-test");
    expect(cfg.activeProfile).toBe("dev");
  });

  it("ignores leftover CHARGEBEE_ENV / CHARGEBEE_REGION and drops them on rewrite", async () => {
    dir = mkdtempSync(join(tmpdir(), "cb-config-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    writeFileSync(
      join(dir, "config"),
      "CHARGEBEE_ENV=production\nCHARGEBEE_REGION=eu-central-1\nCHARGEBEE_DOMAIN=acme-test\n",
    );

    const cfg = await readConfig();
    expect(cfg.domain).toBe("acme-test");
    expect(cfg).not.toHaveProperty("env");
    expect(cfg).not.toHaveProperty("region");

    await writeConfig({ domain: "acme-test" });
    const rewritten = readFileSync(join(dir, "config"), "utf-8");
    expect(rewritten).not.toContain("CHARGEBEE_ENV");
    expect(rewritten).not.toContain("CHARGEBEE_REGION");
    expect(rewritten).toContain("CHARGEBEE_DOMAIN=acme-test");
  });

  it("configDir prefers CHARGEBEE_CONFIG_DIR over HOME", () => {
    dir = mkdtempSync(join(tmpdir(), "cb-config-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    process.env.HOME = "/tmp/cb-home-should-not-win";
    expect(configDir()).toBe(dir);
  });

  it("configDir uses HOME when CHARGEBEE_CONFIG_DIR is unset", () => {
    delete process.env.CHARGEBEE_CONFIG_DIR;
    process.env.HOME = "/tmp/cb-home-config";
    expect(configDir()).toBe(join("/tmp/cb-home-config", ".chargebee", "cli"));
  });

  it("configDir falls back to os.homedir when HOME is unset", () => {
    delete process.env.CHARGEBEE_CONFIG_DIR;
    delete process.env.HOME;
    expect(configDir()).toBe(join(homedir(), ".chargebee", "cli"));
  });

  it("writes the config file at mode 0600 with no leftover temp file", async () => {
    dir = mkdtempSync(join(tmpdir(), "cb-config-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    await writeConfig({ domain: "acme-test", activeProfile: "dev" });
    expect(statSync(join(dir, "config")).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["config"]);
  });
});

describe("peekActiveSiteSync", () => {
  const previousConfigDir = process.env.CHARGEBEE_CONFIG_DIR;
  const previousSite = process.env.CHARGEBEE_SITE;
  const previousKey = process.env.CHARGEBEE_API_KEY;
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (previousConfigDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = previousConfigDir;
    if (previousSite === undefined) delete process.env.CHARGEBEE_SITE;
    else process.env.CHARGEBEE_SITE = previousSite;
    if (previousKey === undefined) delete process.env.CHARGEBEE_API_KEY;
    else process.env.CHARGEBEE_API_KEY = previousKey;
  });

  it("returns the env-var site when both site and key are set", () => {
    dir = mkdtempSync(join(tmpdir(), "cb-peek-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    process.env.CHARGEBEE_SITE = "env-test";
    process.env.CHARGEBEE_API_KEY = "test_xxx";
    expect(peekActiveSiteSync()).toBe("env-test");
  });

  it("returns null when only CHARGEBEE_SITE is set", () => {
    dir = mkdtempSync(join(tmpdir(), "cb-peek-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    process.env.CHARGEBEE_SITE = "env-test";
    delete process.env.CHARGEBEE_API_KEY;
    expect(peekActiveSiteSync()).toBeNull();
  });

  it("returns the active profile site when env vars are absent", () => {
    dir = mkdtempSync(join(tmpdir(), "cb-peek-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    delete process.env.CHARGEBEE_SITE;
    delete process.env.CHARGEBEE_API_KEY;
    writeFileSync(join(dir, "config"), "CHARGEBEE_ACTIVE_PROFILE=dev\n");
    mkdirSync(join(dir, "profiles"), { recursive: true });
    writeFileSync(join(dir, "profiles", "dev.json"), JSON.stringify({ site: "acme-test", api_key: "test_xxx" }));
    expect(peekActiveSiteSync()).toBe("acme-test");
  });

  it("returns null when nothing is configured", () => {
    dir = mkdtempSync(join(tmpdir(), "cb-peek-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    delete process.env.CHARGEBEE_SITE;
    delete process.env.CHARGEBEE_API_KEY;
    expect(peekActiveSiteSync()).toBeNull();
  });
});
