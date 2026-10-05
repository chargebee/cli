import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetRuntimeState,
  __setClientFactory,
  detectCatalog,
} from "../../../../lib/api/sdk.js";

function throwingClient(err: unknown) {
  return {
    configuration: {
      list: async () => {
        throw err;
      },
    },
  } as never;
}

describe("detectCatalog auth errors", () => {
  const prevDir = process.env.CHARGEBEE_CONFIG_DIR;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-sdk-auth-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    __resetRuntimeState();
  });

  afterEach(() => {
    __setClientFactory(null);
    __resetRuntimeState();
    rmSync(dir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prevDir;
  });

  it("maps 404 to a missing-site error", async () => {
    __setClientFactory(() => throwingClient({ http_status_code: 404, message: "not found" }));
    await expect(detectCatalog("nope-test", "key")).rejects.toThrow(/Site "nope-test" not found/);
  });

  it("maps 401 to an invalid-key error", async () => {
    __setClientFactory(() => throwingClient({ http_status_code: 401, message: "unauthorized" }));
    await expect(detectCatalog("acme-test", "bad")).rejects.toThrow(/Invalid API key for "acme-test"/);
  });

  it("maps DNS / connection failures to a reachability error", async () => {
    __setClientFactory(() => throwingClient({ message: "getaddrinfo ENOTFOUND acme-test.chargebee.com" }));
    await expect(detectCatalog("acme-test", "key")).rejects.toThrow(/Could not reach "acme-test"/);
  });

  it("does not treat a 5xx configuration failure as verified", async () => {
    __setClientFactory(() => throwingClient({ http_status_code: 500, message: "unavailable" }));
    await expect(detectCatalog("acme-test", "key")).rejects.toThrow(/Chargebee returned 500; credentials not verified/);
  });

  it("does not treat a 429 configuration failure as verified", async () => {
    __setClientFactory(() => throwingClient({ http_status_code: 429, message: "rate limited" }));
    await expect(detectCatalog("acme-test", "key")).rejects.toThrow(/Chargebee returned 429; credentials not verified/);
  });

  it("treats a 403 on the Configuration API as an authenticated key with unknown catalog", async () => {
    __setClientFactory(() => throwingClient({ http_status_code: 403, message: "forbidden" }));
    expect(await detectCatalog("acme-test", "key")).toEqual({});
  });

  it("maps the SDK's own timeout error (504 + type timeout) to a NetworkError, not a 5xx", async () => {
    __setClientFactory(() => throwingClient({ http_status_code: 504, type: "timeout", message: "io_error" }));
    await expect(detectCatalog("acme-test", "key")).rejects.toThrow(/Could not reach "acme-test": ETIMEDOUT/);
  });

  it("maps a Node `fetch failed` TypeError with a DNS cause to a NetworkError", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND acme-test.chargebee.com"), { code: "ENOTFOUND" });
    __setClientFactory(() => throwingClient(new TypeError("fetch failed", { cause })));
    await expect(detectCatalog("acme-test", "key")).rejects.toThrow(/Could not reach "acme-test": ENOTFOUND/);
  });

  it("maps a Node `fetch failed` TypeError with a connection-refused cause", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
    __setClientFactory(() => throwingClient(new TypeError("fetch failed", { cause })));
    await expect(detectCatalog("acme-test", "key")).rejects.toThrow(/Could not reach "acme-test": ECONNREFUSED/);
  });

  it("maps an AbortError (timeout) to a NetworkError", async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    __setClientFactory(() => throwingClient(err));
    await expect(detectCatalog("acme-test", "key")).rejects.toThrow(/Could not reach "acme-test": ETIMEDOUT/);
  });

  it("maps Bun's fetch error (generic message, code on the error itself) to a NetworkError", async () => {
    const err = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
      code: "ConnectionRefused",
    });
    __setClientFactory(() => throwingClient(err));
    await expect(detectCatalog("acme-test", "key")).rejects.toThrow(/Could not reach "acme-test": ConnectionRefused/);
  });

  it("maps a mid-stream socket close (ECONNRESET on the error itself) to a NetworkError", async () => {
    const err = Object.assign(new Error("The socket connection was closed unexpectedly."), { code: "ECONNRESET" });
    __setClientFactory(() => throwingClient(err));
    await expect(detectCatalog("acme-test", "key")).rejects.toThrow(/Could not reach "acme-test": ECONNRESET/);
  });

  it("returns catalog metadata on success", async () => {
    __setClientFactory(() => ({
      configuration: {
        list: async () => ({
          configurations: [
            { product_catalog_version: "v2", chargebee_response_schema_type: "items" },
          ],
        }),
      },
      customer: { list: async () => ({}) },
    }) as never);
    expect(await detectCatalog("acme-test", "key")).toEqual({
      productCatalogVersion: "v2",
      responseSchemaType: "items",
    });
  });
});
