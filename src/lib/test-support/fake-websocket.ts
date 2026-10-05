/**
 * In-process WebSocket double for tunnel tests. Never opens a network socket.
 */
import type { WebSocketLike } from "../tunnel/appsync.js";

export class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  url: string;
  protocols: string | string[] | undefined;
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onerror: WebSocketLike["onerror"] = null;
  onclose: WebSocketLike["onclose"] = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ reason: "", code: 1000 });
  }

  emit(msg: unknown): void {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }

  emitRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  serverClose(reason = "going away", code = 1001): void {
    this.readyState = 3;
    this.onclose?.({ reason, code });
  }

  parsed(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

export async function waitUntil(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Decode the JSON authorizer claims from the fake socket's header-* subprotocol. */
export function claimsFromSocket(ws: FakeWebSocket): Record<string, unknown> {
  const proto = String((ws.protocols as string[])[1] ?? "");
  const encoded = proto.slice("header-".length);
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (encoded.length % 4)) % 4);
  const auth = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as { Authorization?: string };
  return JSON.parse(Buffer.from(String(auth.Authorization ?? ""), "base64").toString("utf8")) as Record<string, unknown>;
}

export async function handshakeFakeAppSync(): Promise<FakeWebSocket> {
  await waitUntil(() => (FakeWebSocket.instances[0]?.sent.length ?? 0) > 0);
  const ws = FakeWebSocket.instances[0]!;
  ws.emit({ type: "connection_ack" });
  await waitUntil(() => ws.parsed().some((m) => m.type === "subscribe"));
  ws.emit({ type: "subscribe_success" });
  await waitUntil(() => ws.parsed().some((m) => m.type === "publish"));
  return ws;
}
