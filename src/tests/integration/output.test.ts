/**
 * Isolated CLI tests for stdout hygiene: SDK transport fields stay off the JSON body.
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

const SITE = "acme-test";
const KEY = "test_key_v2";

let configDir: string;
let constructions: ClientConstruction[];
const env = createEnvPatcher();

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "cb-output-"));
  env.set("CHARGEBEE_CONFIG_DIR", configDir);
  env.set("CHARGEBEE_SITE", undefined);
  env.set("CHARGEBEE_API_KEY", undefined);
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

describe("output hygiene", () => {
  it("default API JSON is the Postman body: no headers, status, or idempotency flag", async () => {
    await runCli([
      "auth", "add",
      "--profile",
      "dev",
      "--site",
      SITE,
      "--api-key",
      KEY,
    ]);
    const retrieve = await runCli(["customer", "retrieve", "cus_x"]);
    expect(retrieve.exitCode).toBe(0);
    const retrieved = JSON.parse(retrieve.stdout);
    expect(retrieved.customer.id).toBe(`cus_${SITE}`);
    expect(retrieved).not.toHaveProperty("headers");
    expect(retrieved).not.toHaveProperty("httpStatusCode");
    expect(retrieved).not.toHaveProperty("isIdempotencyReplayed");
    expect(retrieve.stderr).not.toContain("Headers:");

    const list = await runCli(["customer", "list"]);
    expect(list.exitCode).toBe(0);
    const listed = JSON.parse(list.stdout);
    expect(listed.list[0].customer.id).toBe(`cus_${SITE}`);
    expect(listed).not.toHaveProperty("headers");
    expect(listed).not.toHaveProperty("httpStatusCode");
  });
});
