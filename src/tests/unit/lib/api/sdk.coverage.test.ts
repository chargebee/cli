import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetRuntimeState,
  __setClientFactory,
  detectCatalog,
  ensureCatalogAllowed,
  ensureWriteAllowed,
  peekActiveSiteName,
  resolveActiveSiteName,
  resolveApiHost,
  resolveAuth,
  setClientIdentifier,
  setHostOverride,
  setProfile,
  transportErrorCode,
  getClient,
  resolveCatalogVersion,
} from "../../../../lib/api/sdk.js";
import { writeConfig } from "../../../../lib/config/store.js";

describe("sdk coverage gaps", () => {
  const prevDir = process.env.CHARGEBEE_CONFIG_DIR;
  const prevSite = process.env.CHARGEBEE_SITE;
  const prevKey = process.env.CHARGEBEE_API_KEY;
  const prevHost = process.env.CHARGEBEE_HOST;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-sdk-cov-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    delete process.env.CHARGEBEE_SITE;
    delete process.env.CHARGEBEE_API_KEY;
    delete process.env.CHARGEBEE_HOST;
    __resetRuntimeState();
  });

  afterEach(() => {
    __setClientFactory(null);
    __resetRuntimeState();
    rmSync(dir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prevDir;
    if (prevSite === undefined) delete process.env.CHARGEBEE_SITE;
    else process.env.CHARGEBEE_SITE = prevSite;
    if (prevKey === undefined) delete process.env.CHARGEBEE_API_KEY;
    else process.env.CHARGEBEE_API_KEY = prevKey;
    if (prevHost === undefined) delete process.env.CHARGEBEE_HOST;
    else process.env.CHARGEBEE_HOST = prevHost;
  });

  it("transportErrorCode ignores non-objects", () => {
    expect(transportErrorCode(undefined)).toBeUndefined();
    expect(transportErrorCode("ENOTFOUND")).toBeUndefined();
  });

  it("detectCatalog treats a status-less error as unverified", async () => {
    __setClientFactory(() => ({
      configuration: {
        list: async () => {
          throw { message: "weird" };
        },
      },
    }) as never);
    await expect(detectCatalog("acme-test", "key")).rejects.toThrow(/credentials not verified/);
  });

  it("setClientIdentifier is a no-throw setter", () => {
    setClientIdentifier("chargebee-cli/test");
  });

  it("setHostOverride is used by resolveApiHost", async () => {
    setHostOverride("example.com");
    expect(await resolveApiHost()).toMatchObject({ suffix: ".example.com" });
  });

  it("setProfile rejects an invalid name", () => {
    expect(() => setProfile("bad name")).toThrow(/Invalid profile name/);
  });

  it("resolveAuth requires SITE and API_KEY together", async () => {
    process.env.CHARGEBEE_SITE = "acme-test";
    await expect(resolveAuth()).rejects.toThrow(/CHARGEBEE_API_KEY is not set/);
  });

  it("resolveAuth reports a missing named profile", async () => {
    setProfile("ghost");
    await expect(resolveAuth()).rejects.toThrow(/Profile "ghost" not found/);
  });

  it("resolveAuth reports a missing active profile on disk", async () => {
    await writeConfig({ domain: "acme-test", activeProfile: "ghost" });
    await expect(resolveAuth()).rejects.toThrow(/Active profile "ghost" not found/);
  });

  it("resolveAuth rejects leftover legacy domain-only config", async () => {
    await writeConfig({ domain: "acme-test", activeProfile: "" });
    await expect(resolveAuth()).rejects.toThrow(/older version of the CLI/);
  });

  it("peekActiveSiteName and resolveActiveSiteName are undefined when unconfigured", async () => {
    expect(await peekActiveSiteName()).toBeUndefined();
    expect(await resolveActiveSiteName()).toBeUndefined();
  });

  it("peekActiveSiteName reads CHARGEBEE_SITE when both env vars are set", async () => {
    process.env.CHARGEBEE_SITE = "env-test";
    process.env.CHARGEBEE_API_KEY = "test_xxx";
    expect(await peekActiveSiteName()).toBe("env-test");
  });

  it("ensureCatalogAllowed is a no-op for catalog-agnostic ops", async () => {
    await ensureCatalogAllowed("both", "customer list");
  });

  it("ensureWriteAllowed is a no-op for GET", async () => {
    await ensureWriteAllowed("GET");
  });

  it("ensureWriteAllowed fails open when nothing is configured", async () => {
    await ensureWriteAllowed("POST");
  });

  it("ensureCatalogAllowed fails open when catalog metadata cannot be read", async () => {
    await writeConfig({ domain: "acme-test", activeProfile: "broken" });
    mkdirSync(join(dir, "profiles"), { recursive: true });
    writeFileSync(join(dir, "profiles", "broken.json"), "{not json");
    await ensureCatalogAllowed("pc2", "item list");
  });

  it("constructs a real Chargebee client when no factory override is set", async () => {
    process.env.CHARGEBEE_SITE = "acme-test";
    process.env.CHARGEBEE_API_KEY = "test_xxx";
    const client = await getClient();
    expect(client).toBeDefined();
    expect(await getClient()).toBe(client);
  });

  it("resolveCatalogVersion is undefined under env-var auth", async () => {
    process.env.CHARGEBEE_SITE = "acme-test";
    process.env.CHARGEBEE_API_KEY = "test_xxx";
    expect(await resolveCatalogVersion()).toBeUndefined();
  });

  it("peekActiveSiteName reads a --use-profile override", async () => {
    mkdirSync(join(dir, "profiles"), { recursive: true });
    writeFileSync(
      join(dir, "profiles", "dev.json"),
      JSON.stringify({ site: "override-test", api_key: "test_xxx" }),
    );
    setProfile("dev");
    expect(await peekActiveSiteName()).toBe("override-test");
    expect(await resolveCatalogVersion()).toBeUndefined();
  });
});
