/**
 * Isolated CLI tests: a path `[id]` argument is rejected when it could not
 * travel as a single URL path segment, and is otherwise handed to the SDK
 * exactly as typed (the SDK does the percent-encoding).
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
let customerRetrieveCalls: string[];
const env = createEnvPatcher();

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "cb-id-validation-"));
  env.set("CHARGEBEE_CONFIG_DIR", configDir);
  env.set("CHARGEBEE_SITE", SITE);
  env.set("CHARGEBEE_API_KEY", KEY);
  env.set("CHARGEBEE_ENV", undefined);
  env.set("CHARGEBEE_HOST", undefined);
  constructions = [];
  customerRetrieveCalls = [];
  installFakeClient({ constructions, customerRetrieveCalls });
});

afterEach(() => {
  uninstallFakeClient();
  env.restore();
  rmSync(configDir, { recursive: true, force: true });
});

describe("generated [id] argument validation", () => {
  it.each(["a/b", "..", "a b", "x?y", "x#y", "a\\b"])(
    "rejects %j before any SDK call",
    async (id) => {
      const result = await runCli(["customer", "retrieve", id]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`error: invalid id "${id}"`);
      expect(result.stderr).toContain('ids may not be "." or ".." or contain "/", "\\", whitespace, "?" or "#"');
      expect(result.stderr).not.toMatch(/\n\s+at /);
      expect(customerRetrieveCalls).toEqual([]);
      expect(constructions).toHaveLength(0);
    }
  );

  it.each(["john@example.com", "ürün-1", "50%off"])(
    "passes %j to the SDK unchanged",
    async (id) => {
      const result = await runCli(["customer", "retrieve", id]);
      expect(result.exitCode).toBe(0);
      expect(customerRetrieveCalls).toEqual([id]);
    }
  );

  it("passes a plain id to the SDK unchanged", async () => {
    const result = await runCli(["customer", "retrieve", "cus_abc123"]);
    expect(result.exitCode).toBe(0);
    expect(customerRetrieveCalls).toEqual(["cus_abc123"]);
  });
});
