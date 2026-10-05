import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { WebhookMsg } from "../protocol/types.js";
import { emitListenPhase } from "../telemetry/index.js";
import { AppSyncErrorCode, classifyAppSyncFailure, listenUserMessage } from "./appsync-errors.js";
import { forward } from "./forwarder.js";
import * as display from "./display.js";

/**
 * AppSync Events transport for `chargebee listen`.
 *
 * Subscribe `/webhooks/{session_id}`; publish heartbeat/disable on
 * `/control/{session_id}`. The CLI never calls webhook-service — AppSync
 * handler Lambdas register the session from the JSON authorizer token.
 *
 * WebSocket protocol (AWS AppSync Events):
 *   1. connect wss://{realtime}/event/realtime with subprotocols
 *      ["aws-appsync-event-ws", "header-<base64url(auth)>"]
 *   2. send {type:"connection_init"} → await {type:"connection_ack"}
 *   3. send {type:"subscribe", channel:"/webhooks/{id}"} → await "subscribe_success"
 *   4. publish {op:"heartbeat"} on /control/{id} every HEARTBEAT_MS
 *   5. receive {type:"data", event:[json strings]} → forward each to localhost
 *   6. on Ctrl+C, publish {op:"disable"} on /control/{id}, then close
 */

export const HEARTBEAT_MS = 30_000;

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev: { reason: string; code: number }) => void) | null;
}

type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocketLike;

export interface AppSyncAuthClaims {
  site: string;
  api_key: string;
  session_id: string;
  chargebee_response_schema_type?: string;
  is_dual_mode: boolean;
}

export interface AppSyncOptions {
  httpDomain: string;
  realtimeDomain: string;
  site: string;
  apiKey: string;
  forwardTo: string;
  /** Stable for the lifetime of this listen process (reused on reconnect). */
  sessionId: string;
  responseSchemaType?: string;
  isDualMode: boolean;
  signal: AbortSignal;
}

const DEFAULT_BACKOFF_MS = 1000;
const DEFAULT_CLOSE_FLUSH_MS = 50;
/** Deadline for connect + `connection_ack` + `subscribe_success`, per attempt. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/**
 * Fallback idle threshold when `connection_ack` carries no `connectionTimeoutMs`.
 * The server's value is the window in which it promises a `ka` frame; each
 * heartbeat also draws a `publish_success`, so a healthy socket is never silent
 * for long.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
/** A session subscribed at least this long counts as healthy; backoff resets. */
const DEFAULT_HEALTHY_MS = 30_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
/** Randomize each sleep by up to this fraction, so parallel CLIs don't retry in lockstep. */
const BACKOFF_JITTER_RATIO = 0.2;

/** WebSocket readyState values (avoid touching a `WebSocket` global that may not exist). */
const WS_CONNECTING = 0;
const WS_OPEN = 1;

/**
 * Test double for the WebSocket constructor; `null` means use the runtime
 * global. Resolved lazily in {@link resolveWebSocketCtor}: the npm bundle runs
 * under plain Node; resolving the global lazily keeps module load free of any
 * runtime-specific global (every command imports this module).
 */
let WebSocketImpl: WebSocketCtor | null = null;
let heartbeatMs = HEARTBEAT_MS;
let initialBackoffMs = DEFAULT_BACKOFF_MS;
let closeFlushMs = DEFAULT_CLOSE_FLUSH_MS;
let connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS;
let idleTimeoutOverrideMs: number | undefined;
let healthyMs = DEFAULT_HEALTHY_MS;
let maxBackoffMs = DEFAULT_MAX_BACKOFF_MS;

/** TEST-ONLY: replace the WebSocket constructor (pass null to restore). Never opens a real socket. */
export function __setWebSocketForTest(ctor: WebSocketCtor | null): void {
  WebSocketImpl = ctor;
}

/** The WebSocket constructor `listen` will use, or `null` when this runtime has none. */
export function resolveWebSocketCtor(): WebSocketCtor | null {
  if (WebSocketImpl) return WebSocketImpl;
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  return typeof ctor === "function" ? (ctor as unknown as WebSocketCtor) : null;
}

/** Printed when {@link resolveWebSocketCtor} is `null` (a runtime without a WebSocket global). */
export const WEBSOCKET_UNAVAILABLE_MESSAGE =
  "chargebee listen requires Node 22+ or the standalone binary.\n\n" +
  `  This Node runtime (${process.version}) has no WebSocket support. Upgrade Node, or install the binary:\n` +
  "  curl -fsSL https://raw.githubusercontent.com/chargebee/cli/main/install.sh | bash";

/** TEST-ONLY: shorten heartbeat / reconnect / close-flush (pass null to restore). */
export function __setTunnelTimingForTest(
  opts: {
    heartbeatMs?: number;
    backoffMs?: number;
    closeFlushMs?: number;
    connectTimeoutMs?: number;
    idleTimeoutMs?: number;
    healthyMs?: number;
    maxBackoffMs?: number;
  } | null,
): void {
  heartbeatMs = opts?.heartbeatMs ?? HEARTBEAT_MS;
  initialBackoffMs = opts?.backoffMs ?? DEFAULT_BACKOFF_MS;
  closeFlushMs = opts?.closeFlushMs ?? DEFAULT_CLOSE_FLUSH_MS;
  connectTimeoutMs = opts?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  idleTimeoutOverrideMs = opts?.idleTimeoutMs;
  healthyMs = opts?.healthyMs ?? DEFAULT_HEALTHY_MS;
  maxBackoffMs = opts?.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
}

const WEBHOOKS_PREFIX = "/webhooks";
const CONTROL_PREFIX = "/control";

/** Token the AppSync Lambda authorizer expects: base64(JSON claims). */
export function authToken(claims: AppSyncAuthClaims): string {
  return btoa(JSON.stringify(claims));
}

export function buildAuthClaims(opts: {
  site: string;
  apiKey: string;
  sessionId: string;
  responseSchemaType?: string;
  isDualMode: boolean;
}): AppSyncAuthClaims {
  const claims: AppSyncAuthClaims = {
    site: opts.site,
    api_key: opts.apiKey,
    session_id: opts.sessionId,
    is_dual_mode: opts.isDualMode,
  };
  if (opts.responseSchemaType) {
    claims.chargebee_response_schema_type = opts.responseSchemaType;
  }
  return claims;
}

/** Build the `header-<base64url(JSON)>` connection subprotocol from an auth object. */
export function authProtocol(authorization: Record<string, string>): string {
  const header = btoa(JSON.stringify(authorization))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header-${header}`;
}

/** Map a Chargebee event payload (from AppSync) into the internal WebhookMsg shape. */
export function toWebhookMsg(event: unknown): WebhookMsg {
  const evt =
    event && typeof event === "object"
      ? (event as Record<string, unknown>)
      : {};
  const eventType =
    typeof evt.event_type === "string" ? evt.event_type : "event";
  const bodyJson = JSON.stringify(event ?? {});
  return {
    type: "webhook",
    request_id: randomUUID(),
    event_type: eventType,
    method: "POST",
    path: "",
    headers: { "content-type": "application/json" },
    body: Buffer.from(bodyJson, "utf8").toString("base64"),
  };
}

export function controlPayload(op: "heartbeat" | "disable"): string {
  return JSON.stringify({ op });
}

/**
 * AppSync `data.event` is an array of JSON strings (up to five). A single
 * string or object is accepted so tests and older doubles still forward.
 * Unreadable array elements are counted in `dropped` and omitted.
 * An unreadable top-level string is kept as-is, matching the previous forward.
 */
export function payloadsFromDataEvent(event: unknown): { payloads: unknown[]; dropped: number } {
  if (Array.isArray(event)) {
    const payloads: unknown[] = [];
    let dropped = 0;
    for (const item of event) {
      if (typeof item === "string") {
        try {
          payloads.push(JSON.parse(item));
        } catch {
          dropped++;
        }
        continue;
      }
      if (item !== null && typeof item === "object") {
        payloads.push(item);
        continue;
      }
      dropped++;
    }
    return { payloads, dropped };
  }
  if (typeof event === "string") {
    try {
      return { payloads: [JSON.parse(event)], dropped: 0 };
    } catch {
      return { payloads: [event], dropped: 0 };
    }
  }
  return { payloads: [event], dropped: 0 };
}

interface ServerMessage {
  type?: string;
  id?: string;
  event?: unknown;
  errors?: unknown;
  failed?: unknown;
  connectionTimeoutMs?: number;
}

/** Close-frame tokens (WS code or `UnauthorizedException`), not AppSync English. */
const UNAUTHORIZED_CLOSE_RE = [/\b401\b/, /\b403\b/, /unauthorizedexception/i];

function isUnauthorizedClose(reason: string, code?: number): boolean {
  if (code === 401 || code === 403) return true;
  return UNAUTHORIZED_CLOSE_RE.some((re) => re.test(reason));
}

/** Drop vendor / pipeline names from a close-frame reason before printing it. */
const PIPELINE_LEAK_RE = /appsync|amazonaws|lambda|unauthorizedexception|authorizer/i;

function publicDisconnectReason(reason: string): string {
  if (PIPELINE_LEAK_RE.test(reason)) return "The webhook tunnel closed.";
  return reason || "The webhook tunnel closed.";
}

type PermanentFailure = { kind: "permanent"; reason: string; code: string; detail?: string };

type ConnectOutcome =
  | { kind: "aborted" }
  | PermanentFailure
  /** `subscribedMs` is absent when the attempt never reached `subscribe_success`. */
  | { kind: "transient"; reason: string; subscribedMs?: number };

/** Why {@link runAppSync} returned: the caller aborted, or a failure that retrying cannot fix. */
export type RunAppSyncOutcome =
  | { kind: "aborted" }
  | PermanentFailure;

/** Sleep for `ms`, resolving early on abort. Registers exactly one abort listener, always removed. */
function sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Apply ±{@link BACKOFF_JITTER_RATIO} jitter to a backoff value, floored at 0. */
function withJitter(ms: number): number {
  const jitter = ms * BACKOFF_JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(ms + jitter));
}

/** At most this many forwards run at once; further events wait their turn. */
const FORWARD_CONCURRENCY = 4;

/**
 * Bounded-concurrency FIFO run queue. Tasks are always *started* in the order
 * they were pushed — including when several fit within the concurrency limit
 * at once — so a burst of events hits the local server in arrival order even
 * though slower ones may still finish after faster, later ones.
 */
class ForwardQueue {
  private readonly pending: Array<() => Promise<void>> = [];
  private active = 0;

  constructor(private readonly concurrency: number) {}

  push(task: () => Promise<void>): void {
    this.pending.push(task);
    this.pump();
  }

  private drained: Array<() => void> = [];

  drain(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.drained.push(resolve));
  }

  private pump(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) break;
      this.active++;
      void task().finally(() => {
        this.active--;
        this.pump();
        if (this.active === 0 && this.pending.length === 0) {
          for (const resolve of this.drained.splice(0)) resolve();
        }
      });
    }
  }
}

/**
 * Subscribe to AppSync Events and forward received events to localhost.
 * Reconnects with exponential backoff (jittered, capped) on a transient
 * disconnect. Returns on abort, or on a permanent failure so the command can
 * report it and pick the exit code.
 */
export async function runAppSync(opts: AppSyncOptions): Promise<RunAppSyncOutcome> {
  // Outside the reconnect loop: a missing implementation must not retry forever.
  if (!resolveWebSocketCtor()) throw new Error(WEBSOCKET_UNAVAILABLE_MESSAGE);

  // One queue for the whole `listen` run, shared across reconnects, so events
  // from before and after a reconnect still forward in the order they arrived.
  const forwardQueue = new ForwardQueue(FORWARD_CONCURRENCY);
  let backoff = initialBackoffMs;
  // One telemetry error event per outage, not one per failed attempt.
  let outageReported = false;

  try {
    while (!opts.signal.aborted) {
      display.startProgress("Connecting webhook tunnel");
      const outcome = await connectAppSync(opts, forwardQueue);

      if (outcome.kind === "aborted" || opts.signal.aborted) return { kind: "aborted" };

      if (outcome.kind === "permanent") {
        emitListenPhase(
          "error",
          outcome.code === AppSyncErrorCode.APPSYNC_UNAUTHORIZED
            ? "listen_unauthorized"
            : "listen_tunnel_error",
        );
        return outcome;
      }

      const wasSubscribed = outcome.subscribedMs !== undefined;
      if (wasSubscribed) outageReported = false;
      if (!outageReported) {
        emitListenPhase("error", "listen_connect_error");
        outageReported = true;
      }
      if ((outcome.subscribedMs ?? -1) >= healthyMs) backoff = initialBackoffMs;

      const wait = withJitter(backoff);
      display.warn(
        `${wasSubscribed ? "Disconnected" : "Could not connect"}: ${outcome.reason}. Reconnecting in ${wait / 1000}s...`,
      );

      await sleepOrAbort(wait, opts.signal);
      if (backoff < maxBackoffMs) backoff = Math.min(maxBackoffMs, backoff * 2);
    }
    return { kind: "aborted" };
  } finally {
    await forwardQueue.drain();
    display.stopProgress();
    if (opts.signal.aborted) emitListenPhase("closed");
  }
}

function connectAppSync(opts: AppSyncOptions, forwardQueue: ForwardQueue): Promise<ConnectOutcome> {
  const {
    httpDomain,
    realtimeDomain,
    site,
    apiKey,
    forwardTo,
    sessionId,
    responseSchemaType,
    isDualMode,
    signal,
  } = opts;

  const channel = `${WEBHOOKS_PREFIX}/${sessionId}`;
  const controlChannel = `${CONTROL_PREFIX}/${sessionId}`;
  const token = authToken(
    buildAuthClaims({
      site,
      apiKey,
      sessionId,
      responseSchemaType,
      isDualMode,
    }),
  );
  const authorization = { host: httpDomain, Authorization: token };

  return new Promise<ConnectOutcome>((resolve) => {
    const Ctor = resolveWebSocketCtor();
    if (!Ctor) {
      resolve({
        kind: "permanent",
        reason: WEBSOCKET_UNAVAILABLE_MESSAGE,
        code: AppSyncErrorCode.WEBSOCKET_UNAVAILABLE,
      });
      return;
    }
    const ws = new Ctor(`wss://${realtimeDomain}/event/realtime`, [
      "aws-appsync-event-ws",
      authProtocol(authorization),
    ]);

    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let connectDeadline: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let idleThresholdMs = idleTimeoutOverrideMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    let subscribedAt: number | undefined;
    let finished = false;

    const stopTimers = () => {
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (connectDeadline !== undefined) clearTimeout(connectDeadline);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      heartbeat = undefined;
      connectDeadline = undefined;
      idleTimer = undefined;
    };

    const publishControl = (op: "heartbeat" | "disable") => {
      if (ws.readyState !== WS_OPEN) return;
      ws.send(
        JSON.stringify({
          id: randomUUID(),
          type: "publish",
          channel: controlChannel,
          events: [controlPayload(op)],
          authorization,
        }),
      );
    };

    const finish = (outcome: ConnectOutcome) => {
      if (finished) return;
      finished = true;
      stopTimers();
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    const closeSocket = () => {
      if (ws.readyState === WS_CONNECTING || ws.readyState === WS_OPEN) {
        ws.close();
      }
    };

    const subscribedMs = () =>
      subscribedAt !== undefined ? Date.now() - subscribedAt : undefined;

    const onAbort = () => {
      publishControl("disable");
      if (closeFlushMs <= 0) {
        closeSocket();
        return;
      }
      setTimeout(closeSocket, closeFlushMs);
    };

    signal.addEventListener("abort", onAbort, { once: true });

    connectDeadline = setTimeout(() => {
      finish({
        kind: "transient",
        reason: "Timed out connecting to the webhook tunnel",
        subscribedMs: subscribedMs(),
      });
      closeSocket();
    }, connectTimeoutMs);

    const armIdleTimer = () => {
      if (finished || idleThresholdMs <= 0) return;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish({
          kind: "transient",
          reason: "No traffic from the webhook tunnel — connection appears dead",
          subscribedMs: subscribedMs(),
        });
        closeSocket();
      }, idleThresholdMs);
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "connection_init" }));
    };

    ws.onmessage = AsyncResource.bind((ev: { data: unknown }) => {
      let msg: ServerMessage;
      try {
        const data = typeof ev.data === "string" ? ev.data : "";
        msg = JSON.parse(data) as ServerMessage;
      } catch {
        return;
      }

      // Any well-formed frame — including "ka" — is proof the socket is alive.
      armIdleTimer();

      switch (msg.type) {
        case "connection_ack":
          if (typeof msg.connectionTimeoutMs === "number" && msg.connectionTimeoutMs > 0) {
            idleThresholdMs = idleTimeoutOverrideMs ?? msg.connectionTimeoutMs;
          }
          ws.send(
            JSON.stringify({
              type: "subscribe",
              id: sessionId,
              channel,
              authorization,
            }),
          );
          break;
        case "subscribe_success":
          if (connectDeadline !== undefined) clearTimeout(connectDeadline);
          connectDeadline = undefined;
          subscribedAt = Date.now();
          display.ready(forwardTo);
          emitListenPhase("established");
          publishControl("heartbeat");
          heartbeat = setInterval(() => publishControl("heartbeat"), heartbeatMs);
          armIdleTimer();
          break;
        case "subscribe_error":
        case "connection_error":
        case "error": {
          const failure = classifyAppSyncFailure(msg);
          finish(
            failure.permanent
              ? {
                  kind: "permanent",
                  reason: failure.reason,
                  code: failure.code,
                  detail: failure.detail,
                }
              : { kind: "transient", reason: failure.reason, subscribedMs: subscribedMs() },
          );
          closeSocket();
          break;
        }
        case "publish_error":
          display.warn("Session keepalive failed");
          break;
        case "publish_success":
          if (Array.isArray(msg.failed) && msg.failed.length > 0) {
            display.warn("Session keepalive failed");
          }
          break;
        case "broadcast_error":
          display.warn("A webhook event could not be delivered");
          break;
        case "data": {
          const { payloads, dropped } = payloadsFromDataEvent(msg.event);
          if (dropped > 0) {
            display.warn("Skipped a webhook event with an unreadable payload");
          }
          for (const payload of payloads) {
            const webhookMsg = toWebhookMsg(payload);
            forwardQueue.push(() => handleEvent(webhookMsg, forwardTo));
          }
          break;
        }
        // "ka" and a clean "publish_success": no action beyond the liveness reset above.
      }
    });

    ws.onerror = () => {
      // onerror is always followed by onclose
    };

    ws.onclose = (ev) => {
      if (signal.aborted) {
        finish({ kind: "aborted" });
        return;
      }
      const raw = ev.reason || `WebSocket closed (code ${ev.code})`;
      const permanent = isUnauthorizedClose(raw, ev.code);
      finish(
        permanent
          ? {
              kind: "permanent",
              reason: listenUserMessage(AppSyncErrorCode.APPSYNC_UNAUTHORIZED),
              code: AppSyncErrorCode.APPSYNC_UNAUTHORIZED,
            }
          : { kind: "transient", reason: publicDisconnectReason(raw), subscribedMs: subscribedMs() },
      );
    };
  });
}

async function handleEvent(msg: WebhookMsg, forwardTo: string): Promise<void> {
  try {
    const resp = await forward(forwardTo, msg);
    display.event(msg.event_type, resp.status);
  } catch (err) {
    display.eventFailed(msg.event_type, err instanceof Error ? err.message : String(err));
  }
}

