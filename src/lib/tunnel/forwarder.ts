import type { WebhookMsg, ProxyResponse } from "../protocol/types.js";

/**
 * Hop-by-hop headers must not be forwarded between proxies (RFC 7230 §6.1).
 * Stripping them prevents downstream HTTP servers from misinterpreting connection state.
 */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "transfer-encoding",
  "te", "trailer", "upgrade", "proxy-authorization",
]);

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** TEST-ONLY: replace fetch (pass null to restore). */
export function __setFetchForTest(fn: FetchFn | null): void {
  fetchImpl = fn ?? (globalThis.fetch.bind(globalThis) as FetchFn);
}

let fetchImpl: FetchFn = globalThis.fetch.bind(globalThis) as FetchFn;

export type ForwardTargetResult =
  | { url: string; warning?: string }
  | { error: string };

/** `localhost`, any 127.0.0.0/8 address, or the IPv6 loopback (brackets already stripped). */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

const FORWARD_TO_EXAMPLE = "Example: --forward-to http://localhost:3000/webhook";

/** Chargebee event type names are lowercase dotted/underscored slugs; anything else can't be a real one. */
const EVENT_TYPE_HEADER_RE = /^[a-z0-9_.:-]+$/;

/**
 * Validate and normalize a `--forward-to` value into an absolute http(s) URL.
 *
 * A bare port (`3000`, `:3000`) is shorthand for `http://localhost:<port>`.
 * A bare loopback host (`localhost`, `127.x.x.x`, `::1`, `[::1]`), with or
 * without a port/path, is shorthand for the same host under `http://`.
 * Anything else — a relative path, a bare non-loopback host, or an
 * unparsable/non-http(s) URL — is rejected rather than guessed at. A resolved
 * non-loopback target carries a `warning`, since webhook payloads may contain
 * customer data.
 */
export function resolveForwardTarget(raw: string): ForwardTargetResult {
  const value = raw.trim();
  if (!value) {
    return { error: `--forward-to must not be empty.\n\n  ${FORWARD_TO_EXAMPLE}` };
  }

  const portOnly = /^:?(\d+)(\/.*)?$/.exec(value);
  const loopbackShorthand =
    /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\])(:\d+)?(\/.*)?$/i.exec(value);

  let candidate: string;
  if (/^https?:\/\//i.test(value)) {
    candidate = value;
  } else if (portOnly) {
    candidate = `http://localhost:${portOnly[1]}${portOnly[2] ?? ""}`;
  } else if (loopbackShorthand) {
    const [, host, port = "", path = ""] = loopbackShorthand;
    candidate = `http://${host === "::1" ? "[::1]" : host}${port}${path}`;
  } else {
    return {
      error:
        `--forward-to "${raw}" is not a valid URL. Use a full http:// or https:// URL, or just a port.\n\n  ${FORWARD_TO_EXAMPLE}`,
    };
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { error: `--forward-to "${raw}" is not a valid URL.\n\n  ${FORWARD_TO_EXAMPLE}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      error: `--forward-to "${raw}" must use http:// or https://.\n\n  ${FORWARD_TO_EXAMPLE}`,
    };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isLoopbackHost(hostname)) {
    return { url: candidate };
  }
  return {
    url: candidate,
    warning: `--forward-to points at a non-loopback host (${hostname}); webhook payloads may contain customer data.`,
  };
}

/**
 * Forward a webhook to a local HTTP server and return its response.
 *
 * Body is decoded from base64 (relay-side encoding). Hop-by-hop headers are stripped.
 * `X-Chargebee-Event-Type` is injected, when it matches the expected event-name
 * shape, so consumers can branch without parsing the body — an `event_type` the
 * relay didn't send in that shape is untrusted and the header is omitted rather
 * than passed through as a header value.
 * Default timeout is 8s. Connection failures include the forwarding target and a server availability hint.
 */
export async function forward(
  targetURL: string,
  msg: WebhookMsg,
  signal?: AbortSignal
): Promise<ProxyResponse> {
  const body = Buffer.from(msg.body, "base64");

  const headers = new Headers();
  for (const [k, v] of Object.entries(msg.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) {
      headers.set(k, v);
    }
  }
  if (EVENT_TYPE_HEADER_RE.test(msg.event_type)) {
    headers.set("X-Chargebee-Event-Type", msg.event_type);
  }

  const resp = await fetchImpl(targetURL, {
    method: msg.method,
    headers,
    body,
    signal: signal ?? AbortSignal.timeout(8000),
  }).catch((err: Error) => {
    const connectionError = err as Error & { code?: string; cause?: { code?: string } };
    if (
      connectionError.code === "ECONNREFUSED" ||
      connectionError.cause?.code === "ECONNREFUSED" ||
      /ECONNREFUSED|Unable to connect/i.test(err.message)
    ) {
      throw new Error(`Unable to forward to ${targetURL}. Ensure the server is running and reachable.`, { cause: err });
    }
    throw err;
  });

  const respBody = await resp.text();
  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    respHeaders[k] = v;
  });

  return { status: resp.status, headers: respHeaders, body: respBody };
}
