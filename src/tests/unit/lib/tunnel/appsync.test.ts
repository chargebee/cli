import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { getEventListeners } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spoolPath } from "../../../../lib/telemetry/constants.js";
import { clearCiEnv } from "../../../../lib/test-support/_helpers.js";
import {
  __resetTelemetryRecorderForTest,
  __setSpawnForTest,
  installTelemetry,
} from "../../../../lib/telemetry/index.js";
import { writeState } from "../../../../lib/telemetry/state.js";
import type { SpoolRecord } from "../../../../lib/telemetry/types.js";
import { __setFetchForTest } from "../../../../lib/tunnel/forwarder.js";
import {
  __setTunnelTimingForTest,
  __setWebSocketForTest,
  authProtocol,
  authToken,
  buildAuthClaims,
  controlPayload,
  payloadsFromDataEvent,
  runAppSync,
  toWebhookMsg,
  type AppSyncOptions,
  type RunAppSyncOutcome,
} from "../../../../lib/tunnel/appsync.js";
import { stopProgress } from "../../../../lib/tunnel/display.js";
import {
  FakeWebSocket,
  waitUntil,
} from "../../../../lib/test-support/fake-websocket.js";

// The telemetry recorder is disabled on CI runners; the reliability tests read
// the spool it writes, so CI detection is cleared for this file.
let restoreCiEnv: () => void = () => undefined;
beforeEach(() => {
  restoreCiEnv = clearCiEnv();
});
afterEach(() => {
  restoreCiEnv();
  stopProgress();
});

describe("authToken", () => {
  test("base64-encodes the JSON authorizer claims", () => {
    const claims = buildAuthClaims({
      site: "acme-test",
      apiKey: "test_123",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      responseSchemaType: "plans_addons",
      isDualMode: false,
    });
    const decoded = JSON.parse(
      Buffer.from(authToken(claims), "base64").toString("utf8"),
    );
    expect(decoded).toEqual({
      site: "acme-test",
      api_key: "test_123",
      session_id: "550e8400-e29b-41d4-a716-446655440000",
      chargebee_response_schema_type: "plans_addons",
      is_dual_mode: false,
    });
    expect(decoded).not.toHaveProperty("api_version");
  });

  test("omits schema when unknown", () => {
    const claims = buildAuthClaims({
      site: "acme-test",
      apiKey: "test_123",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      isDualMode: true,
    });
    const decoded = JSON.parse(
      Buffer.from(authToken(claims), "base64").toString("utf8"),
    );
    expect(decoded.is_dual_mode).toBe(true);
    expect(decoded).not.toHaveProperty("chargebee_response_schema_type");
  });
});

describe("authProtocol", () => {
  test("prefixes header- and is base64url (no +, /, =)", () => {
    const proto = authProtocol({ host: "h", Authorization: "a+b/c==" });
    expect(proto.startsWith("header-")).toBe(true);
    const encoded = proto.slice("header-".length);
    expect(encoded).not.toMatch(/[+/=]/);
  });

  test("round-trips back to the original authorization object", () => {
    const auth = {
      host: "example.appsync-api.us-east-2.amazonaws.com",
      Authorization: "tok",
    };
    const encoded = authProtocol(auth).slice("header-".length);
    const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    expect(decoded).toEqual(auth);
  });
});

describe("toWebhookMsg", () => {
  test("maps a Chargebee event into a POST WebhookMsg with base64 JSON body", () => {
    const event = {
      event_type: "subscription_created",
      content: { id: "sub_1" },
    };
    const msg = toWebhookMsg(event);

    expect(msg.type).toBe("webhook");
    expect(msg.method).toBe("POST");
    expect(msg.event_type).toBe("subscription_created");
    expect(msg.headers["content-type"]).toBe("application/json");
    expect(typeof msg.request_id).toBe("string");

    const decoded = JSON.parse(
      Buffer.from(msg.body, "base64").toString("utf8"),
    );
    expect(decoded).toEqual(event);
  });

  test("defaults event_type when missing", () => {
    expect(toWebhookMsg({ foo: "bar" }).event_type).toBe("event");
    expect(toWebhookMsg(null).event_type).toBe("event");
  });
});

describe("payloadsFromDataEvent", () => {
  test("parses the documented array of JSON strings, in order", () => {
    const first = { event_type: "subscription_created", id: "ev_1" };
    const second = { event_type: "invoice_generated", id: "ev_2" };
    const parsed = payloadsFromDataEvent([
      JSON.stringify(first),
      JSON.stringify(second),
    ]);
    expect(parsed).toEqual({ payloads: [first, second], dropped: 0 });
  });

  test("skips an unreadable array element and keeps objects and valid strings", () => {
    const good = { event_type: "subscription_created" };
    const already = { event_type: "invoice_generated" };
    const parsed = payloadsFromDataEvent([
      JSON.stringify(good),
      already,
      "{not json",
      null,
      1,
    ]);
    expect(parsed).toEqual({ payloads: [good, already], dropped: 3 });
  });

  test("accepts a single JSON string or object", () => {
    const event = { event_type: "subscription_created" };
    expect(payloadsFromDataEvent(JSON.stringify(event))).toEqual({
      payloads: [event],
      dropped: 0,
    });
    expect(payloadsFromDataEvent(event)).toEqual({
      payloads: [event],
      dropped: 0,
    });
  });

  test("keeps an unreadable top-level string", () => {
    expect(payloadsFromDataEvent("{not json")).toEqual({
      payloads: ["{not json"],
      dropped: 0,
    });
  });
});

describe("controlPayload", () => {
  test("encodes heartbeat and disable ops", () => {
    expect(JSON.parse(controlPayload("heartbeat"))).toEqual({
      op: "heartbeat",
    });
    expect(JSON.parse(controlPayload("disable"))).toEqual({ op: "disable" });
  });
});

function baseOpts(over: Partial<AppSyncOptions> = {}): {
  opts: AppSyncOptions;
  ac: AbortController;
} {
  const ac = new AbortController();
  return {
    ac,
    opts: {
      httpDomain: "http.example.amazonaws.com",
      realtimeDomain: "rt.example.amazonaws.com",
      site: "acme-test",
      apiKey: "test_xxx",
      forwardTo: "http://localhost:3000/webhook",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      isDualMode: false,
      signal: ac.signal,
      ...over,
    },
  };
}

async function handshake(): Promise<{
  ws: FakeWebSocket;
  ac: AbortController;
  done: Promise<RunAppSyncOutcome>;
}> {
  FakeWebSocket.instances = [];
  const { opts, ac } = baseOpts();
  const done = runAppSync(opts);
  await waitUntil(() => (FakeWebSocket.instances[0]?.sent.length ?? 0) > 0);
  const ws = FakeWebSocket.instances[0]!;
  ws.emit({ type: "connection_ack" });
  await waitUntil(() => ws.parsed().some((m) => m.type === "subscribe"));
  ws.emit({ type: "subscribe_success" });
  await waitUntil(() => ws.parsed().some((m) => m.type === "publish"));
  return { ws, ac, done };
}

describe("runAppSync (fake WebSocket)", () => {
  afterEach(() => {
    __setWebSocketForTest(null);
    __setTunnelTimingForTest(null);
    __setFetchForTest(null);
  });

  test("handshakes, heartbeats, forwards events, and publishes disable on abort", async () => {
    __setWebSocketForTest(FakeWebSocket);
    __setTunnelTimingForTest({ heartbeatMs: 20, closeFlushMs: 50 });
    const fetches: {
      url: string;
      method?: string;
      headers: Record<string, string>;
      body: string;
    }[] = [];
    __setFetchForTest(async (url, init) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      fetches.push({
        url: String(url),
        method: init?.method,
        headers,
        body: Buffer.isBuffer(init?.body)
          ? init.body.toString("utf8")
          : String(init?.body ?? ""),
      });
      return new Response("ok", { status: 201 });
    });

    const logs: string[] = [];
    const origLog = console.log;
    const origError = process.stderr.write;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    process.stderr.write = ((chunk: unknown) => {
      logs.push(String(chunk).trim());
      return true;
    }) as never;

    let ac: AbortController | undefined;
    let done: Promise<RunAppSyncOutcome> | undefined;
    try {
      const hs = await handshake();
      ac = hs.ac;
      done = hs.done;
      const { ws } = hs;

      expect(ws.url).toBe("wss://rt.example.amazonaws.com/event/realtime");
      expect(ws.protocols?.[0]).toBe("aws-appsync-event-ws");
      expect(String((ws.protocols as string[])[1]).startsWith("header-")).toBe(
        true,
      );
      expect(ws.parsed()[0]).toEqual({ type: "connection_init" });

      const sub = ws.parsed().find((m) => m.type === "subscribe");
      expect(sub?.channel).toBe(
        "/webhooks/550e8400-e29b-41d4-a716-446655440000",
      );
      expect(
        logs.some((l) =>
          l.startsWith(
            "> Ready! Forwarding events to http://localhost:3000/webhook",
          ),
        ),
      ).toBe(true);
      expect(logs.join("\n")).not.toContain("appsync");

      const heartbeats = () =>
        ws
          .parsed()
          .filter(
            (m) =>
              m.type === "publish" &&
              (m.events as string[])?.[0] === '{"op":"heartbeat"}',
          );
      expect(heartbeats().length).toBeGreaterThanOrEqual(1);
      expect(heartbeats()[0]?.channel).toBe(
        "/control/550e8400-e29b-41d4-a716-446655440000",
      );

      await waitUntil(() => heartbeats().length >= 2);

      ws.emit({ type: "ka" });
      ws.emit({ type: "publish_success" });
      ws.emit("not-json");
      ws.emitRaw(123);
      ws.emit({
        type: "data",
        event: { event_type: "subscription_created", id: "ev_1" },
      });
      await waitUntil(() => fetches.length === 1);
      expect(fetches[0]?.url).toBe("http://localhost:3000/webhook");
      expect(fetches[0]?.method).toBe("POST");
      expect(fetches[0]?.headers["x-chargebee-event-type"]).toBe(
        "subscription_created",
      );
      expect(JSON.parse(fetches[0]!.body)).toEqual({
        event_type: "subscription_created",
        id: "ev_1",
      });
      await waitUntil(() =>
        logs.some((l) => /subscription_created \u2192 201/.test(l)),
      );

      ws.emit({
        type: "data",
        event: JSON.stringify({ event_type: "invoice_generated" }),
      });
      await waitUntil(() => fetches.length === 2);
      expect(fetches[1]?.headers["x-chargebee-event-type"]).toBe(
        "invoice_generated",
      );

      ws.emit({ type: "data", event: "{not json" });
      await waitUntil(() => fetches.length === 3);
      expect(fetches[2]?.headers["x-chargebee-event-type"]).toBe("event");

      ac.abort();
      await done;
      const disable = ws
        .parsed()
        .filter(
          (m) =>
            m.type === "publish" &&
            (m.events as string[])?.[0] === '{"op":"disable"}',
        );
      expect(disable).toHaveLength(1);
      expect(ws.parsed().every((m) => m.type !== "unsubscribe")).toBe(true);
    } finally {
      ac?.abort();
      await done;
      console.log = origLog;
      process.stderr.write = origError;
    }
  });

  test("warns on publish_error and logs forward failures", async () => {
    __setWebSocketForTest(FakeWebSocket);
    __setFetchForTest(async () => {
      throw new Error("ECONNREFUSED");
    });

    const logs: string[] = [];
    const origLog = console.log;
    const origError = process.stderr.write;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    process.stderr.write = ((chunk: unknown) => {
      logs.push(String(chunk).trim());
      return true;
    }) as never;

    try {
      const { ws, ac, done } = await handshake();
      ws.emit({ type: "publish_error", errors: [{ message: "throttled" }] });
      ws.emit({ type: "data", event: { event_type: "subscription_created" } });
      await waitUntil(() => logs.some((l) => l.includes("failed:")));
      expect(logs).toContain("> Session keepalive failed");
      expect(
        logs.some((l) =>
          l.includes("subscription_created \u2192 failed:") &&
          l.includes("Unable to forward to http://localhost:3000/webhook. Ensure the server is running and reachable."),
        ),
      ).toBe(true);

      ac.abort();
      await done;
    } finally {
      console.log = origLog;
      process.stderr.write = origError;
    }
  });

  test("forwards a documented data frame and keeps the socket after broadcast and keepalive failures", async () => {
    __setWebSocketForTest(FakeWebSocket);
    const fetched: string[] = [];
    __setFetchForTest(async (_url, init) => {
      const body = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
      fetched.push((JSON.parse(body) as { event_type: string }).event_type);
      return new Response("ok", { status: 200 });
    });

    const logs: string[] = [];
    const origLog = console.log;
    const origError = process.stderr.write;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    process.stderr.write = ((chunk: unknown) => {
      logs.push(String(chunk).trim());
      return true;
    }) as never;

    try {
      const { ws, ac, done } = await handshake();
      ws.emit({
        type: "data",
        id: "550e8400-e29b-41d4-a716-446655440000",
        event: [
          JSON.stringify({ event_type: "subscription_created", id: "ev_1" }),
          "{not json",
          JSON.stringify({ event_type: "invoice_generated", id: "ev_2" }),
        ],
      });
      await waitUntil(() => fetched.length === 2);
      expect(fetched).toEqual(["subscription_created", "invoice_generated"]);
      expect(logs).toContain("> Skipped a webhook event with an unreadable payload");

      ws.emit({ type: "broadcast_error", errors: [{ message: "MessageProcessingError" }] });
      ws.emit({ type: "publish_success", failed: [{ index: 0 }] });
      ws.emit({ type: "publish_success", failed: [] });
      expect(logs).toContain("> A webhook event could not be delivered");
      expect(logs.filter((l) => l === "> Session keepalive failed")).toHaveLength(1);

      ws.emit({
        type: "data",
        event: [JSON.stringify({ event_type: "payment_succeeded" })],
      });
      await waitUntil(() => fetched.length === 3);
      expect(fetched[2]).toBe("payment_succeeded");

      ac.abort();
      await done;
    } finally {
      console.log = origLog;
      process.stderr.write = origError;
    }
  });

  test("caps in-flight forwards at four and starts queued ones in arrival order", async () => {
    __setWebSocketForTest(FakeWebSocket);
    const started: string[] = [];
    const release: Array<() => void> = [];

    // Every forward blocks until the test releases it, so the local target is
    // as slow as it can be and nothing completes on its own.
    __setFetchForTest(async (_url, init) => {
      const body = Buffer.isBuffer(init?.body) ? init.body.toString("utf8") : String(init?.body ?? "");
      started.push((JSON.parse(body) as { event_type: string }).event_type);
      await new Promise<void>((resolve) => release.push(resolve));
      return new Response("ok", { status: 200 });
    });

    const { ws, ac, done } = await handshake();
    try {
      for (const eventType of ["e1", "e2", "e3", "e4", "e5", "e6"]) {
        ws.emit({ type: "data", event: { event_type: eventType } });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(started).toEqual(["e1", "e2", "e3", "e4"]);

      release.shift()!();
      await waitUntil(() => started.length === 5);
      expect(started[4]).toBe("e5");

      release.shift()!();
      await waitUntil(() => started.length === 6);
      expect(started).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
    } finally {
      while (release.length > 0) release.shift()!();
      ac.abort();
      await done;
    }
  });

  test("surfaces a non-2xx local response distinctly from a success", async () => {
    __setWebSocketForTest(FakeWebSocket);
    __setFetchForTest(async () => new Response("error", { status: 500 }));

    const logs: string[] = [];
    const origLog = console.log;
    const origError = process.stderr.write;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    process.stderr.write = ((chunk: unknown) => {
      logs.push(String(chunk).trim());
      return true;
    }) as never;

    try {
      const { ws, ac, done } = await handshake();
      ws.emit({ type: "data", event: { event_type: "subscription_created" } });
      await waitUntil(() => logs.some((l) => l.includes("\u2192 500")));
      expect(logs.some((l) => l.includes("subscription_created \u2192 500 (non-2xx)"))).toBe(true);

      ac.abort();
      await done;
    } finally {
      console.log = origLog;
      process.stderr.write = origError;
    }
  });

  test("sanitises a hostile event_type before printing it", async () => {
    __setWebSocketForTest(FakeWebSocket);
    __setFetchForTest(async () => new Response("ok", { status: 200 }));

    const logs: string[] = [];
    const origLog = console.log;
    const origError = process.stderr.write;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    process.stderr.write = ((chunk: unknown) => {
      logs.push(String(chunk).trim());
      return true;
    }) as never;

    try {
      const { ws, ac, done } = await handshake();
      ws.emit({
        type: "data",
        event: { event_type: "sub[31mcreated\n" },
      });
      await waitUntil(() => logs.some((l) => l.includes("\u2192 200")));
      expect(logs.some((l) => l.includes("\x1b[31m"))).toBe(false);
      expect(logs.some((l) => l.includes("sub[31mcreated \u2192 200"))).toBe(true);

      ac.abort();
      await done;
    } finally {
      console.log = origLog;
      process.stderr.write = origError;
    }
  });

  test("reconnects after unexpected close and subscribe_error, then stops on abort", async () => {
    __setWebSocketForTest(FakeWebSocket);
    __setTunnelTimingForTest({ backoffMs: 15, closeFlushMs: 0 });

    const logs: string[] = [];
    const origLog = console.log;
    const origError = process.stderr.write;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    process.stderr.write = ((chunk: unknown) => {
      logs.push(String(chunk).trim());
      return true;
    }) as never;

    try {
      FakeWebSocket.instances = [];
      const { opts, ac } = baseOpts();
      const done = runAppSync(opts);
      await waitUntil(() => (FakeWebSocket.instances[0]?.sent.length ?? 0) > 0);
      const first = FakeWebSocket.instances[0]!;
      first.emit({ type: "connection_ack" });
      await waitUntil(() => first.parsed().some((m) => m.type === "subscribe"));
      first.emit({ type: "subscribe_error", errors: [{ message: "nope" }] });

      await waitUntil(() =>
        logs.some((l) => l.includes("Could not connect: The webhook tunnel returned an error.")),
      );
      await waitUntil(() => FakeWebSocket.instances.length >= 2);

      const second = FakeWebSocket.instances[1]!;
      await waitUntil(() => second.sent.length > 0);
      second.serverClose();
      await waitUntil(
        () => logs.filter((l) => l.includes("Reconnecting in")).length >= 2,
      );

      ac.abort();
      await done;
      expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    } finally {
      console.log = origLog;
      process.stderr.write = origError;
    }
  });
});

describe("runAppSync reliability (fake WebSocket)", () => {
  afterEach(() => {
    __setWebSocketForTest(null);
    __setTunnelTimingForTest(null);
    __setFetchForTest(null);
  });

  function captureLogs(): { logs: string[]; restore: () => void } {
    const logs: string[] = [];
    const origLog = console.log;
    const origError = process.stderr.write;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    process.stderr.write = ((chunk: unknown) => {
      logs.push(String(chunk).trim());
      return true;
    }) as never;
    return {
      logs,
      restore: () => {
        console.log = origLog;
        process.stderr.write = origError;
      },
    };
  }

  test("aborts and retries a connect attempt that never acks within the deadline", async () => {
    __setWebSocketForTest(FakeWebSocket);
    __setTunnelTimingForTest({ connectTimeoutMs: 15, backoffMs: 10, closeFlushMs: 0 });
    const { logs, restore } = captureLogs();

    try {
      FakeWebSocket.instances = [];
      const { opts, ac } = baseOpts();
      const done = runAppSync(opts);
      // Never emit connection_ack  the deadline must fire on its own.
      await waitUntil(() => FakeWebSocket.instances.length >= 2, 2000);
      expect(
        logs.some((l) =>
          l.includes("Could not connect: Timed out connecting to the webhook tunnel. Reconnecting"),
        ),
      ).toBe(true);
      expect(logs.some((l) => l.startsWith("> Disconnected"))).toBe(false);

      ac.abort();
      await done;
    } finally {
      restore();
    }
  });

  test("closes and reconnects when no traffic arrives within the idle threshold", async () => {
    __setWebSocketForTest(FakeWebSocket);
    __setTunnelTimingForTest({
      idleTimeoutMs: 15,
      backoffMs: 10,
      closeFlushMs: 0,
      connectTimeoutMs: 5000,
    });
    const { logs, restore } = captureLogs();

    try {
      const { ws, ac, done } = await handshake();
      expect(ws.readyState).toBe(1);

      // No "ka" or any other frame arrives  the socket goes idle after subscribing.
      await waitUntil(() => FakeWebSocket.instances.length >= 2, 2000);
      expect(ws.readyState).toBe(3);
      expect(
        logs.some((l) => l.includes("Disconnected: No traffic from the webhook tunnel")),
      ).toBe(true);

      ac.abort();
      await done;
    } finally {
      restore();
    }
  });

  test("returns a permanent outcome without retrying on an authorizer rejection", async () => {
    __setWebSocketForTest(FakeWebSocket);
    __setTunnelTimingForTest({ backoffMs: 10, closeFlushMs: 0 });
    const { logs, restore } = captureLogs();

    try {
      FakeWebSocket.instances = [];
      const { opts } = baseOpts();
      const done = runAppSync(opts);
      await waitUntil(() => (FakeWebSocket.instances[0]?.sent.length ?? 0) > 0);
      const ws = FakeWebSocket.instances[0]!;
      ws.emit({ type: "connection_ack" });
      await waitUntil(() => ws.parsed().some((m) => m.type === "subscribe"));
      ws.emit({
        type: "subscribe_error",
        errors: [{ errorType: "UnauthorizedException", message: "token expired" }],
      });

      await expect(done).resolves.toEqual({
        kind: "permanent",
        reason: "Could not authorize the listen session.",
        code: "APPSYNC_UNAUTHORIZED",
      });
      expect(logs.some((l) => l.includes("Reconnecting"))).toBe(false);
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test("returns a permanent ENABLE_FAILED outcome on a 4xx handler error", async () => {
    __setWebSocketForTest(FakeWebSocket);
    __setTunnelTimingForTest({ backoffMs: 10, closeFlushMs: 0 });
    const { logs, restore } = captureLogs();

    try {
      FakeWebSocket.instances = [];
      const { opts } = baseOpts();
      const done = runAppSync(opts);
      await waitUntil(() => (FakeWebSocket.instances[0]?.sent.length ?? 0) > 0);
      const ws = FakeWebSocket.instances[0]!;
      ws.emit({ type: "connection_ack" });
      await waitUntil(() => ws.parsed().some((m) => m.type === "subscribe"));
      ws.emit({
        type: "subscribe_error",
        errors: [{ message: "ENABLE_FAILED:401" }],
      });

      await expect(done).resolves.toEqual({
        kind: "permanent",
        reason: "Could not register the listen session with Chargebee (HTTP 401).",
        code: "ENABLE_FAILED",
        detail: "401",
      });
      expect(logs.some((l) => l.includes("Reconnecting"))).toBe(false);
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test("retries ENABLE_FAILED 5xx instead of exiting", async () => {
    __setWebSocketForTest(FakeWebSocket);
    __setTunnelTimingForTest({ backoffMs: 10, closeFlushMs: 0 });
    const { logs, restore } = captureLogs();

    try {
      FakeWebSocket.instances = [];
      const { opts, ac } = baseOpts();
      const done = runAppSync(opts);
      await waitUntil(() => (FakeWebSocket.instances[0]?.sent.length ?? 0) > 0);
      const ws = FakeWebSocket.instances[0]!;
      ws.emit({ type: "connection_ack" });
      await waitUntil(() => ws.parsed().some((m) => m.type === "subscribe"));
      ws.emit({
        type: "subscribe_error",
        errors: [{ message: "ENABLE_FAILED:503" }],
      });

      await waitUntil(() => FakeWebSocket.instances.length >= 2, 2000);
      expect(logs.some((l) => l.includes("Reconnecting"))).toBe(true);
      ac.abort();
      await done;
    } finally {
      restore();
    }
  });

  test("treats keep-alive frames as liveness and stays on the same socket", async () => {
    __setWebSocketForTest(FakeWebSocket);
    __setTunnelTimingForTest({
      idleTimeoutMs: 30,
      backoffMs: 10,
      closeFlushMs: 0,
      connectTimeoutMs: 5000,
    });

    const { ws, ac, done } = await handshake();
    // Well past the idle threshold, with only "ka" frames arriving.
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 10));
      ws.emit({ type: "ka" });
    }
    expect(ws.readyState).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(1);

    ac.abort();
    await done;
  });

  test("sizes the idle threshold from connection_ack.connectionTimeoutMs", async () => {
    __setWebSocketForTest(FakeWebSocket);
    // No idleTimeoutMs override: the server's value must apply (the default is 60s).
    __setTunnelTimingForTest({ backoffMs: 10, closeFlushMs: 0, connectTimeoutMs: 5000 });
    const { restore } = captureLogs();

    try {
      FakeWebSocket.instances = [];
      const { opts, ac } = baseOpts();
      const done = runAppSync(opts);
      await waitUntil(() => (FakeWebSocket.instances[0]?.sent.length ?? 0) > 0);
      const ws = FakeWebSocket.instances[0]!;
      ws.emit({ type: "connection_ack", connectionTimeoutMs: 20 });
      await waitUntil(() => ws.parsed().some((m) => m.type === "subscribe"));
      ws.emit({ type: "subscribe_success" });

      await waitUntil(() => FakeWebSocket.instances.length >= 2, 2000);
      expect(ws.readyState).toBe(3);

      ac.abort();
      await done;
    } finally {
      restore();
    }
  });

  test("emits one telemetry error phase per outage, not one per failed attempt", async () => {
    __setWebSocketForTest(FakeWebSocket);
    __setTunnelTimingForTest({
      backoffMs: 5,
      closeFlushMs: 0,
      idleTimeoutMs: 5000,
      maxBackoffMs: 5,
    });
    const dir = mkdtempSync(join(tmpdir(), "cb-appsync-telemetry-"));
    const prevDir = process.env.CHARGEBEE_CONFIG_DIR;
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    writeState({ notice_shown: true });
    __resetTelemetryRecorderForTest();
    __setSpawnForTest(() => ({ unref() {} }));
    const { restore } = captureLogs();

    try {
      FakeWebSocket.instances = [];
      const { opts, ac } = baseOpts();
      const program = new Command();
      program.exitOverride();
      program.command("listen").action(async () => {
        await runAppSync(opts);
      });
      installTelemetry(program, "1.0.0-test");
      const run = program.parseAsync(["listen"], { from: "user" });

      // Outage 1: three attempts close before the handshake completes.
      for (let i = 0; i < 3; i++) {
        await waitUntil(() => FakeWebSocket.instances.length >= i + 1);
        const ws = FakeWebSocket.instances[i]!;
        await waitUntil(() => ws.sent.length > 0);
        ws.serverClose();
      }
      // Recovery: a full handshake reaches Ready.
      await waitUntil(() => FakeWebSocket.instances.length >= 4);
      const healthy = FakeWebSocket.instances[3]!;
      await waitUntil(() => healthy.sent.length > 0);
      healthy.emit({ type: "connection_ack" });
      await waitUntil(() => healthy.parsed().some((m) => m.type === "subscribe"));
      healthy.emit({ type: "subscribe_success" });
      // Outage 2.
      healthy.serverClose();
      await waitUntil(() => FakeWebSocket.instances.length >= 5);

      ac.abort();
      await run;

      const phases = readFileSync(spoolPath(), "utf-8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as SpoolRecord).event.metadata.listen_phase);
      expect(phases).toEqual(["error", "established", "error", "closed"]);
    } finally {
      restore();
      __resetTelemetryRecorderForTest();
      __setSpawnForTest(null);
      if (prevDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
      else process.env.CHARGEBEE_CONFIG_DIR = prevDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resets backoff to the base after a session stays subscribed past the healthy threshold", async () => {
    __setWebSocketForTest(FakeWebSocket);
    __setTunnelTimingForTest({
      backoffMs: 10,
      closeFlushMs: 0,
      healthyMs: 20,
      idleTimeoutMs: 5000,
    });
    const { logs, restore } = captureLogs();

    const waitMsFromLog = (index: number): number => {
      const line = logs.filter((l) => l.includes("Reconnecting in"))[index];
      const m = /Reconnecting in ([\d.]+)s/.exec(line ?? "");
      if (!m) throw new Error(`no reconnect log at index ${index}: ${JSON.stringify(logs)}`);
      return Number(m[1]) * 1000;
    };

    try {
      FakeWebSocket.instances = [];
      const { opts, ac } = baseOpts();
      const done = runAppSync(opts);

      // First session: dies immediately (never healthy) -> backoff grows from base.
      await waitUntil(() => (FakeWebSocket.instances[0]?.sent.length ?? 0) > 0);
      FakeWebSocket.instances[0]!.emit({ type: "connection_ack" });
      await waitUntil(() =>
        FakeWebSocket.instances[0]!.parsed().some((m) => m.type === "subscribe"),
      );
      FakeWebSocket.instances[0]!.emit({ type: "subscribe_success" });
      FakeWebSocket.instances[0]!.serverClose();
      await waitUntil(() => logs.some((l) => l.includes("Reconnecting in")));
      const firstWait = waitMsFromLog(0);
      expect(firstWait).toBeGreaterThanOrEqual(8);
      expect(firstWait).toBeLessThanOrEqual(12);

      // Second session: outlives the healthy threshold -> backoff resets to base.
      await waitUntil(() => FakeWebSocket.instances.length >= 2);
      const second = FakeWebSocket.instances[1]!;
      await waitUntil(() => second.sent.length > 0);
      second.emit({ type: "connection_ack" });
      await waitUntil(() => second.parsed().some((m) => m.type === "subscribe"));
      second.emit({ type: "subscribe_success" });
      await new Promise((r) => setTimeout(r, 30));
      second.serverClose();
      await waitUntil(
        () => logs.filter((l) => l.includes("Reconnecting in")).length >= 2,
      );
      const secondWait = waitMsFromLog(1);
      expect(secondWait).toBeGreaterThanOrEqual(8);
      expect(secondWait).toBeLessThanOrEqual(12);

      ac.abort();
      await done;
    } finally {
      restore();
    }
  });

  test("registers at most one abort listener across many reconnect cycles", async () => {
    __setWebSocketForTest(FakeWebSocket);
    __setTunnelTimingForTest({
      backoffMs: 5,
      closeFlushMs: 0,
      idleTimeoutMs: 5000,
      maxBackoffMs: 20,
    });

    FakeWebSocket.instances = [];
    const { opts, ac } = baseOpts();
    const done = runAppSync(opts);

    for (let i = 0; i < 10; i++) {
      await waitUntil(() => FakeWebSocket.instances.length >= i + 1);
      const ws = FakeWebSocket.instances[i]!;
      await waitUntil(() => ws.sent.length > 0);
      ws.serverClose();
      expect(getEventListeners(ac.signal, "abort").length).toBeLessThanOrEqual(1);
    }

    ac.abort();
    await done;
    expect(getEventListeners(ac.signal, "abort").length).toBe(0);
  });
});
