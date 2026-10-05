import { afterEach, describe, expect, it } from "bun:test";

import { postBatch } from "../../../../lib/telemetry/client.js";
import type { CliAnalyticsCreateRequest } from "../../../../lib/telemetry/types.js";

const body: CliAnalyticsCreateRequest = {
  client: "CHARGEBEE_CLI",
  visitor_id: "vid",
  site_name: "acme-test",
  cli_version: "1.0.0",
  events: [{ name: "customer list", timestamp: new Date().toISOString(), metadata: {} }],
};

describe("postBatch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns true on 2xx", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 204 })) as unknown as typeof fetch;
    expect(await postBatch("https://example.test/ingest", body)).toBe(true);
  });

  it("returns false on non-2xx", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await postBatch("https://example.test/ingest", body)).toBe(false);
  });

  it("returns false and never throws on network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await postBatch("https://example.test/ingest", body)).toBe(false);
  });

  it("POSTs JSON without an Origin header", async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, i?: RequestInit) => {
      init = i;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await postBatch("https://example.test/ingest", body);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(new Headers(init?.headers).get("origin")).toBeNull();
  });

  it("returns false when the request is aborted by the timeout", async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      await new Promise<never>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await postBatch("https://example.test/ingest", body)).toBe(false);
  }, 10_000);
});
