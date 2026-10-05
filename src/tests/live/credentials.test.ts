import { afterAll, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnCli } from "../../lib/test-support/_spawn.js";
import { liveCatalogChecks } from "../../lib/test-support/live-catalog.js";
import { platformKeychain } from "../../lib/config/keychain.js";
import { liveEnabled, requireLive, validateLiveFixtures, liveConfig, testSites, successful, jsonResult } from "../../lib/test-support/live.js";

const detectedCatalogs = new Set<string>();
const enabled = liveEnabled && process.env.CHARGEBEE_TEST_OS_KEYCHAIN === "1";
it("requires native credential storage in trusted live runs", () => {
  if (requireLive && !enabled) throw new Error("Live profile scenarios require CHARGEBEE_TEST_OS_KEYCHAIN=1 and a provisioned native credential session");
});

for (const [index, fixture] of testSites.entries()) {
  it.skipIf(!enabled)(`US test site ${index + 1}: configure, keychain, catalog gate, rename, use and remove through the artifact`, async () => {
    validateLiveFixtures();
    const dir = liveConfig();
    const name = `ci-${randomUUID()}`;
    const renamed = `${name}-renamed`;
    const previousDir = process.env.CHARGEBEE_CONFIG_DIR;
    const store = platformKeychain();
    if (!store) { rmSync(dir, { recursive: true, force: true }); throw new Error("Native credential store unavailable"); }
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    const extraEnv = { CHARGEBEE_CLI_KEYCHAIN: "1", CHARGEBEE_REGION: "us" };
    const cli = (args: string[]) => spawnCli(args, { configDir: dir, extraEnv });
    try {
      // Configure resolves its key from the environment; it is never put in argv.
      successful(await spawnCli(["auth", "add", "--profile", name, "--region", "us"], {
        configDir: dir, extraEnv: { ...extraEnv, CHARGEBEE_SITE: fixture.site, CHARGEBEE_API_KEY: fixture.key },
      }), "configure with native keychain");
      const disk = JSON.parse(readFileSync(join(dir, "profiles", `${name}.json`), "utf8"));
      expect(disk.api_key_source).toBe("keychain");
      expect("api_key" in disk).toBe(false);
      const checks = liveCatalogChecks(disk.product_catalog_version, disk.chargebee_response_schema_type);
      detectedCatalogs.add(checks.catalog);
      console.info(`US test site slot ${index + 1}: detected ${checks.catalog} catalog`);
      expect((await store.get(name)) === fixture.key).toBe(true);
      successful(await cli(["auth", "status"]), "profile status");
      successful(await cli(["whoami"]), "whoami");
      expect((await cli(["auth", "list"])).stdout).toContain(name);
      for (const resource of checks.allowed) {
        const data = jsonResult(await cli(["--use-profile", name, resource, "list", "-d", "limit=1"]), "catalog-compatible read");
        expect(Array.isArray(data.list)).toBe(true);
      }
      for (const resource of checks.blocked) {
        for (const suffix of [[], ["--code-sample", "curl"]]) {
          const refusal = await cli(["--use-profile", name, resource, "list", ...suffix]);
          expect(refusal.exitCode).toBe(6);
          expect(refusal.stderr).toContain("isn't available on your site");
        }
      }
      successful(await cli(["auth", "rename", name, renamed]), "profile rename");
      expect((await store.get(name)) === null).toBe(true);
      expect((await store.get(renamed)) === fixture.key).toBe(true);
      successful(await cli(["auth", "switch", renamed]), "profile use");
      jsonResult(await cli(["customer", "list", "-d", "limit=1"]), "credential-backed read after rename");
      const removed = await cli(["auth", "remove", renamed, "--yes"]);
      successful(removed, "profile remove");
      expect(removed.stderr).not.toMatch(/may remain|cleanup was skipped/);
      expect((await store.get(renamed)) === null).toBe(true);
    } finally {
      try { await store.delete(name); }
      finally {
        try { await store.delete(renamed); }
        finally {
          if (previousDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
          else process.env.CHARGEBEE_CONFIG_DIR = previousDir;
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  }, 240_000);
}

afterAll(() => {
  if (!enabled) return;
  if (!detectedCatalogs.has("pc1")) {
    console.info("Real PC1-only coverage unavailable: no PC1-only fixture was detected; synthetic gate tests remain in CI.");
  }
  if (!detectedCatalogs.has("pc2")) {
    console.info("Real PC2-only coverage unavailable: no PC2-only fixture was detected; synthetic gate tests remain in CI.");
  }
});
