import { expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { spawnCli } from "../../lib/test-support/_spawn.js";
import { liveEnabled, liveSiteEnabled, requireLive, validateLiveFixtures, validateLiveSite, withCustomer, jsonResult, liveConfig, successful } from "../../lib/test-support/live.js";

it("requires explicitly provisioned US fixtures in trusted live runs", () => {
  if (requireLive || liveEnabled) validateLiveFixtures();
  if (requireLive || liveSiteEnabled) validateLiveSite();
});

for (const index of [0, 1]) {
  it.skipIf(!liveEnabled)(`US test site ${index + 1}: creates, retrieves, filters and deletes a customer`, async () => {
    await withCustomer(index, async (id, extraEnv) => {
      const retrieved = jsonResult(await spawnCli(["customer", "retrieve", id], { extraEnv }), "customer retrieve");
      expect(retrieved.customer.id).toBe(id);
      const deadline = Date.now() + 60_000;
      let ids: string[] = [];
      do {
        const filtered = jsonResult(await spawnCli(["customer", "list", "-d", `id[is]=${id}`, "limit=1"], { extraEnv }), "customer filter");
        ids = filtered.list.map((entry: any) => entry.customer.id);
        if (ids.includes(id)) break;
        await Bun.sleep(1000);
      } while (Date.now() < deadline);
      expect(ids).toEqual([id]);
    });
  }, 600_000);
}

it.skipIf(!liveSiteEnabled)("US LIVE site allows reads and refuses customer creation in the compiled CLI", async () => {
  validateLiveSite();
  const extraEnv = { CHARGEBEE_SITE: process.env.CB_LIVE_SITE!, CHARGEBEE_API_KEY: process.env.CB_LIVE_KEY!, CHARGEBEE_REGION: "us" };
  const dir = liveConfig();
  try {
    // Inspect only the response shape, never log live customer records.
    const response = jsonResult(await spawnCli(["customer", "list", "-d", "limit=1"], { configDir: dir, extraEnv }), "LIVE customer list");
    expect(Array.isArray(response.list)).toBe(true);
    const rejected = await spawnCli(["customer", "create", "-d", "id=cb-cli-write-gate-must-not-exist"], { configDir: dir, extraEnv });
    expect(rejected.exitCode).toBe(6);
    expect(rejected.stderr).toContain("Refusing to run a write operation on live site");
    expect(rejected.stdout).toBe("");
    const sample = await spawnCli(["customer", "create", "--code-sample", "curl"], { configDir: dir, extraEnv });
    successful(sample, "LIVE code sample (no API write)");
    expect(sample.stdout).toContain("curl");
    expect(sample.stdout.includes(extraEnv.CHARGEBEE_API_KEY)).toBe(false);
    const listen = await spawnCli(["listen", "-f", "http://127.0.0.1:1"], { configDir: dir, extraEnv });
    expect(listen.exitCode).toBe(1);
    expect(listen.stderr).toContain("Refusing to listen on live site");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 120_000);

it.skipIf(!liveEnabled)("US test site rejects an invalid key with the authentication exit code", async () => {
  validateLiveFixtures();
  const result = await spawnCli(["customer", "list", "-d", "limit=1"], {
    extraEnv: { CHARGEBEE_SITE: process.env.CB_TEST_SITE_1!, CHARGEBEE_API_KEY: "test_deliberately_invalid" },
  });
  expect(result.exitCode).toBe(4);
  expect(result.stdout).toBe("");
}, 60_000);
