import { afterEach, describe, expect, test } from "bun:test";

import type { WebhookMsg } from "../../../../lib/protocol/types.js";
import {
  __setFetchForTest,
  forward,
  resolveForwardTarget,
} from "../../../../lib/tunnel/forwarder.js";

const msg: WebhookMsg = {
  type: "webhook",
  request_id: "req_1",
  event_type: "subscription_created",
  method: "POST",
  path: "",
  headers: {
    "content-type": "application/json",
    connection: "keep-alive",
    "keep-alive": "timeout=5",
    "transfer-encoding": "chunked",
    "x-custom": "yes",
  },
  body: Buffer.from('{"id":"sub_1"}', "utf8").toString("base64"),
};

afterEach(() => {
  __setFetchForTest(null);
});

describe("forward", () => {
  test("strips hop-by-hop headers and injects X-Chargebee-Event-Type", async () => {
    const seen: { url: string; method?: string; headers: Record<string, string>; body: string }[] = [];
    __setFetchForTest(async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      seen.push({
        url: String(url),
        method: init?.method,
        headers,
        body: Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? ""),
      });
      return new Response("forwarded", { status: 202, headers: { "x-local": "1" } });
    });

    const resp = await forward("http://localhost:3000/webhook", msg);
    expect(resp).toEqual({
      status: 202,
      headers: { "x-local": "1" },
      body: "forwarded",
    });
    expect(seen[0]?.url).toBe("http://localhost:3000/webhook");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.body).toBe('{"id":"sub_1"}');
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
    expect(seen[0]?.headers["x-custom"]).toBe("yes");
    expect(seen[0]?.headers["x-chargebee-event-type"]).toBe("subscription_created");
    expect(seen[0]?.headers["connection"]).toBeUndefined();
    expect(seen[0]?.headers["keep-alive"]).toBeUndefined();
    expect(seen[0]?.headers["transfer-encoding"]).toBeUndefined();
  });

  test.each([
    { label: "connection code in message", error: new Error("fetch failed: ECONNREFUSED 127.0.0.1:3000") },
    { label: "Bun connection error", error: Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ECONNREFUSED" }) },
    { label: "Bun message without code", error: new Error("Unable to connect. Is the computer able to access the url?") },
    { label: "Node nested connection error", error: new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }) },
  ])("explains an unavailable target: $label", async ({ error }) => {
    __setFetchForTest(async () => { throw error; });
    const failure = await forward("http://localhost:3000/webhook", msg).catch(error => error);
    expect(failure.message).toBe("Unable to forward to http://localhost:3000/webhook. Ensure the server is running and reachable.");
    expect(failure.cause).toBe(error);
  });

  test("rethrows other fetch errors", async () => {
    __setFetchForTest(async () => {
      throw new Error("the socket hung up");
    });
    await expect(forward("http://localhost:3000/webhook", msg)).rejects.toThrow("the socket hung up");
  });

  test("forwards a caller abort signal", async () => {
    const ac = new AbortController();
    let passed: AbortSignal | undefined;
    __setFetchForTest(async (_url, init) => {
      passed = init?.signal as AbortSignal | undefined;
      return new Response("ok", { status: 200 });
    });
    await forward("http://localhost:3000/webhook", msg, ac.signal);
    expect(passed).toBe(ac.signal);
  });

  test("omits X-Chargebee-Event-Type rather than pass through a hostile value", async () => {
    let headers: Record<string, string> = {};
    __setFetchForTest(async (_url, init) => {
      const h: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        h[k] = v;
      });
      headers = h;
      return new Response("ok", { status: 200 });
    });

    await forward("http://localhost:3000/webhook", {
      ...msg,
      event_type: "subscription_created\r\nX-Injected: yes",
    });
    expect(headers["x-chargebee-event-type"]).toBeUndefined();
    expect(headers["x-injected"]).toBeUndefined();
  });

  test("keeps X-Chargebee-Event-Type for a well-formed event type", async () => {
    let headers: Record<string, string> = {};
    __setFetchForTest(async (_url, init) => {
      const h: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        h[k] = v;
      });
      headers = h;
      return new Response("ok", { status: 200 });
    });

    await forward("http://localhost:3000/webhook", { ...msg, event_type: "invoice_generated" });
    expect(headers["x-chargebee-event-type"]).toBe("invoice_generated");
  });
});

describe("resolveForwardTarget", () => {
  test.each([
    ["localhost:3000/webhook", "http://localhost:3000/webhook"],
    ["localhost:4000/hook", "http://localhost:4000/hook"],
    ["http://localhost:3000/webhook", "http://localhost:3000/webhook"],
    ["https://127.0.0.1:9/wh", "https://127.0.0.1:9/wh"],
    ["3000", "http://localhost:3000"],
    [":3000", "http://localhost:3000"],
    ["3000/webhook", "http://localhost:3000/webhook"],
    [":3000/webhook", "http://localhost:3000/webhook"],
    ["::1", "http://[::1]"],
    ["::1:3000/x", "http://[::1]:3000/x"],
    ["[::1]:3000/x", "http://[::1]:3000/x"],
    ["http://[::1]:3000/x", "http://[::1]:3000/x"],
    ["127.0.0.2:3000", "http://127.0.0.2:3000"],
    ["http://127.255.0.1:3000/x", "http://127.255.0.1:3000/x"],
  ])("accepts %s -> %s with no warning", (input, expected) => {
    const result = resolveForwardTarget(input);
    expect(result).toEqual({ url: expected });
  });

  test("warns once for a non-loopback https target", () => {
    const result = resolveForwardTarget("https://example.com/x");
    expect(result).toEqual({
      url: "https://example.com/x",
      warning: expect.stringContaining("non-loopback host (example.com)"),
    });
  });

  test.each([["http://0.0.0.0:3000"], ["http://128.0.0.1:3000"], ["http://10.0.0.5:3000"]])(
    "warns for %s",
    (input) => {
      const result = resolveForwardTarget(input);
      expect("warning" in result && result.warning).toContain("non-loopback host");
    },
  );

  test.each([
    ["/webhook"],
    [""],
    ["   "],
    ["httpfoo:3000"],
    ["httpfoo"],
    ["ftp://example.com/x"],
  ])("rejects %s", (input) => {
    const result = resolveForwardTarget(input);
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("--forward-to");
    }
  });
});
