/**
 * `-` reads one JSON object from stdin and passes it to the SDK.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetRuntimeState, __setClientFactory } from "../../lib/api/sdk.js";
import { __setStdinSource } from "../../lib/api/stdin-params.js";
import {
  createEnvPatcher,
  installFakeClient,
  runCli,
  setStdinIsTTY,
  uninstallFakeClient,
  type ClientConstruction,
} from "../../lib/test-support/_helpers.js";

const SITE = "acme-test";
const KEY = "test_key_v2";

let configDir: string;
let constructions: ClientConstruction[];
let restoreStdin: (() => void) | undefined;
const env = createEnvPatcher();

function pipe(text: string): void {
  __setStdinSource(async function* () {
    yield text;
  });
}

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "cb-stdin-"));
  env.set("CHARGEBEE_CONFIG_DIR", configDir);
  env.set("CHARGEBEE_SITE", undefined);
  env.set("CHARGEBEE_API_KEY", undefined);
  constructions = [];
  installFakeClient({ constructions });
  restoreStdin = setStdinIsTTY(false);
  await runCli(["auth", "add", "--profile", "dev", "--site", SITE, "--api-key", KEY]);
});

afterEach(() => {
  restoreStdin?.();
  __setStdinSource(null);
  uninstallFakeClient();
  __resetRuntimeState();
  env.restore();
  rmSync(configDir, { recursive: true, force: true });
});

describe("JSON stdin", () => {
  it("documents '-' on create help", async () => {
    const { stdout, exitCode } = await runCli(["customer", "create", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("'-' reads a JSON object from stdin.");
  });

  it("sends a create body with scalars, a nested object, and an array of objects", async () => {
    let params: unknown;
    __setClientFactory(() => ({
      customer: {
        create: async (body: unknown) => {
          params = body;
          return { customer: { id: "cust_new" } };
        },
      },
    }) as never);
    pipe(
      JSON.stringify({
        id: "foo",
        channel: "web",
        net_term_days: 10,
        billing_address: { city: "San Francisco" },
        subscription_items: [{ item_price_id: "basic-USD", quantity: 1 }],
      }),
    );
    const { exitCode, stdout } = await runCli(["customer", "create", "-"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("cust_new");
    expect(params).toEqual({
      id: "foo",
      channel: "web",
      net_term_days: 10,
      billing_address: { city: "San Francisco" },
      subscription_items: [{ item_price_id: "basic-USD", quantity: 1 }],
    });
  });

  it("sends list filters and an export filter object", async () => {
    let listed: unknown;
    let exported: unknown;
    __setClientFactory(() => ({
      customer: {
        list: async (body: unknown) => {
          listed = body;
          return { list: [] };
        },
      },
      export: {
        customers: async (body: unknown) => {
          exported = body;
          return { export: { id: "exp_1" } };
        },
      },
    }) as never);

    pipe(JSON.stringify({ email: { is: "ada@example.com" }, status: { in: ["active", "paused"] } }));
    const listedResult = await runCli(["customer", "list", "-"]);
    expect(listedResult.exitCode).toBe(0);
    expect(listed).toEqual({
      "email[is]": "ada@example.com",
      "status[in]": '["active","paused"]',
    });

    pipe(JSON.stringify({ "customer[email][is]": "ada@example.com" }));
    const exportedResult = await runCli(["export", "customers", "-"]);
    expect(exportedResult.exitCode).toBe(0);
    expect(exported).toEqual({ customer: { email: { is: "ada@example.com" } } });
  });

  it("updates with the id before '-'", async () => {
    let seen: { id?: string; params?: unknown } = {};
    __setClientFactory(() => ({
      customer: {
        update: async (id: string, params: unknown) => {
          seen = { id, params };
          return { customer: { id } };
        },
      },
    }) as never);
    pipe(JSON.stringify({ first_name: "Ada" }));
    const { exitCode } = await runCli(["customer", "update", "cust_123", "-"]);
    expect(exitCode).toBe(0);
    expect(seen).toEqual({ id: "cust_123", params: { first_name: "Ada" } });
  });

  it("includes piped fields in a code sample", async () => {
    pipe(JSON.stringify({ email: "ada@example.com" }));
    const { stdout, exitCode } = await runCli(["customer", "create", "-", "--code-sample", "curl"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ada@example.com");
  });

  it("rejects '-' together with -d, and '-' as an id", async () => {
    pipe(JSON.stringify({ email: "ada@example.com" }));
    const mixed = await runCli(["customer", "create", "-", "-d", "id=foo"]);
    expect(mixed.exitCode).not.toBe(0);
    expect(mixed.stderr).toContain("not both");

    const missingId = await runCli(["customer", "update", "-"]);
    expect(missingId.exitCode).not.toBe(0);
    expect(missingId.stderr).toContain("Pass the resource id before");
  });

  it("warns when a list JSON field has no operator", async () => {
    __setClientFactory(() => ({
      customer: {
        list: async () => ({ list: [] }),
      },
    }) as never);
    pipe(JSON.stringify({ email: "ada@example.com" }));
    const { stderr, exitCode } = await runCli(["customer", "list", "-"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("email[is]=ada@example.com");
  });
});
