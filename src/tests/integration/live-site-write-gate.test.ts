/**
 * Isolated CLI tests: the live-site write gate as emitted into the generated
 * commands. A live site refuses mutating operations before any SDK client is
 * constructed, still runs reads, and still runs the non-GET operations that
 * only compute or generate URLs (estimates, exports). A test site runs writes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEnvPatcher,
  installFakeClient,
  uninstallFakeClient,
  runCli,
  type ClientConstruction,
} from "../../lib/test-support/_helpers.js";

const REFUSAL = "Refusing to run a write operation on live site";

let configDir: string;
let constructions: ClientConstruction[];
const env = createEnvPatcher();

function useSite(site: string, apiKey: string): void {
  env.set("CHARGEBEE_SITE", site);
  env.set("CHARGEBEE_API_KEY", apiKey);
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "cb-live-gate-"));
  env.set("CHARGEBEE_CONFIG_DIR", configDir);
  env.set("CHARGEBEE_ENV", undefined);
  env.set("CHARGEBEE_HOST", undefined);
  constructions = [];
  installFakeClient({ constructions });
});

afterEach(() => {
  uninstallFakeClient();
  env.restore();
  rmSync(configDir, { recursive: true, force: true });
});

describe("live site", () => {
  beforeEach(() => useSite("acme", "live_key"));

  it("refuses a plain write before constructing a client", async () => {
    const result = await runCli(["customer", "create", "-d", "first_name=Ada"]);
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain(REFUSAL);
    expect(constructions).toHaveLength(0);
  });

  it("refuses a state-writing operation on an otherwise read-only resource", async () => {
    const result = await runCli(["hosted-page", "acknowledge", "hp_1"]);
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain(REFUSAL);
    expect(constructions).toHaveLength(0);
  });

  it("runs a GET read", async () => {
    const result = await runCli(["customer", "retrieve", "cus_1"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cus_acme");
  });

  it("runs a POST estimate", async () => {
    const result = await runCli([
      "estimate",
      "create-sub-item-estimate",
      "-d",
      "subscription_items[item_price_id][0]=basic",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain(REFUSAL);
    expect(result.stdout).toContain("est_acme");
  });

  it("runs a POST export", async () => {
    const result = await runCli(["export", "customers"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain(REFUSAL);
    expect(result.stdout).toContain("exp_acme");
  });
});

describe("test site", () => {
  beforeEach(() => useSite("acme-test", "live_key"));

  it("runs a plain write", async () => {
    const result = await runCli(["customer", "create", "-d", "first_name=Ada"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cus_new_acme-test");
  });
});
