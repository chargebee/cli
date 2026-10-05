import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnCli, writeDisabledTelemetry, type SpawnCliResult } from "./_spawn.js";

export const requireLive = process.env.CB_REQUIRE_LIVE === "1";
export const liveEnabled = Boolean(process.env.CB_TEST_SITE_1 && process.env.CB_TEST_KEY_1 && process.env.CB_TEST_SITE_2 && process.env.CB_TEST_KEY_2);
export const liveSiteEnabled = Boolean(process.env.CB_LIVE_SITE && process.env.CB_LIVE_KEY);
export const testSites = [1, 2].map((index) => ({
  site: process.env[`CB_TEST_SITE_${index}`] ?? "",
  key: process.env[`CB_TEST_KEY_${index}`] ?? "",
}));

export function validateLiveFixtures(): void {
  if (!liveEnabled) throw new Error("Set CB_TEST_SITE_1/KEY_1 and CB_TEST_SITE_2/KEY_2 to two US test sites");
  if (testSites.some(({ site }) => !/^[a-z0-9][a-z0-9-]*-test$/i.test(site))) {
    throw new Error("Customer lifecycle tests require site names ending in -test");
  }
  if (testSites[0].site === testSites[1].site) throw new Error("Test fixtures must be distinct sites");
}

export function validateLiveSite(): void {
  if (!liveSiteEnabled) throw new Error("Set CB_LIVE_SITE and CB_LIVE_KEY to a US live validation site and read-only key");
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(process.env.CB_LIVE_SITE!) || /-test$/i.test(process.env.CB_LIVE_SITE!) || /^test_/i.test(process.env.CB_LIVE_KEY!)) {
    throw new Error("LIVE validation requires a live-mode site/key pair");
  }
}

export function fixtureEnv(index = 0): Record<string, string> {
  validateLiveFixtures();
  return { CHARGEBEE_SITE: testSites[index].site, CHARGEBEE_API_KEY: testSites[index].key, CHARGEBEE_REGION: "us" };
}

export function liveConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "cb-live-scenario-"));
  writeDisabledTelemetry(dir);
  return dir;
}

/** Never print actual API responses/credentials into CI diagnostics. */
export function successful(result: SpawnCliResult, operation: string): void {
  if (result.exitCode !== 0) throw new Error(`${operation} failed with CLI exit code ${result.exitCode}`);
}

export function jsonResult(result: SpawnCliResult, operation: string): any {
  successful(result, operation);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`${operation} did not return JSON`); }
}

/** Preallocate the ID so teardown also works if creation succeeds server-side but times out locally. */
export async function withCustomer(index: number, run: (id: string, env: Record<string, string>) => Promise<void>, execute: typeof spawnCli = spawnCli): Promise<void> {
  const env = fixtureEnv(index);
  const id = `cb-cli-${process.platform}-${randomUUID()}`;
  const dir = liveConfig();
  console.error(`Customer fixture ${id} on test site slot ${index + 1}`);
  const failures: unknown[] = [];
  try {
    const result = await execute(["customer", "create", "-"], {
      configDir: dir, extraEnv: env, input: JSON.stringify({ id, first_name: "CLI validation" }),
    });
    const data = jsonResult(result, "customer create");
    if (data.customer?.id !== id) throw new Error("customer create returned an unexpected fixture ID");
    await run(id, env);
  } catch (err) { failures.push(err); }
  finally {
    try {
      let deletionAccepted = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const removed = await execute(["customer", "delete", id], { configDir: dir, extraEnv: env });
          if (removed.exitCode === 0 || removed.exitCode === 5) { deletionAccepted = true; break; }
        } catch { /* Retry a transport failure using the same known fixture ID. */ }
        await Bun.sleep(1000 * (attempt + 1));
      }
      // Customer deletion is asynchronous; accept a tombstone or a not-found response.
      let cleaned = false;
      const deadline = Date.now() + 180_000;
      while (deletionAccepted && Date.now() < deadline) {
        try {
          const check = await execute(["customer", "retrieve", id], { configDir: dir, extraEnv: env });
          if (check.exitCode === 5) { cleaned = true; break; }
          if (check.exitCode === 0) {
            const customer = JSON.parse(check.stdout).customer;
            if (customer?.id === id && customer.deleted === true) { cleaned = true; break; }
          }
        } catch { /* An accepted deletion may still be completing. */ }
        await Bun.sleep(2000);
      }
      if (!cleaned) throw new Error(`Customer cleanup failed for fixture ${id} on test site slot ${index + 1}; manual cleanup required`);
    } catch (err) { failures.push(err); }
    rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length) throw new AggregateError(failures, "Customer scenario or cleanup failed");
}
