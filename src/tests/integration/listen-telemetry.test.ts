/**
 * Telemetry lifecycle events spooled by `chargebee listen` across failed
 * attempts, drops and reconnects. Runs the real program with an in-process
 * fake WebSocket and a stubbed flush — never AppSync, never the network.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetRuntimeState } from "../../lib/api/sdk.js";
import { __setAppsyncTableForTest } from "../../lib/config/urls.js";
import { spoolPath } from "../../lib/telemetry/constants.js";
import {
  __resetTelemetryRecorderForTest,
  __setSpawnForTest,
  installTelemetry,
} from "../../lib/telemetry/index.js";
import { writeState } from "../../lib/telemetry/state.js";
import type { SpoolRecord } from "../../lib/telemetry/types.js";
import {
  __setTunnelTimingForTest,
  __setWebSocketForTest,
} from "../../lib/tunnel/appsync.js";
import { __setFetchForTest } from "../../lib/tunnel/forwarder.js";
import { FakeWebSocket, waitUntil } from "../../lib/test-support/fake-websocket.js";
import {
  clearCiEnv,
  createEnvPatcher,
  installFakeClient,
  runCli,
  setStderrIsTTY,
  uninstallFakeClient,
} from "../../lib/test-support/_helpers.js";

const env = createEnvPatcher();
let configDir: string;
let restoreCiEnv: () => void = () => undefined;
let restoreStderrTty: (() => void) | undefined;

beforeEach(() => {
  // The recorder is disabled on CI runners; this file reads the spool it writes.
  restoreCiEnv = clearCiEnv();
  configDir = mkdtempSync(join(tmpdir(), "cb-listen-telemetry-"));
  env.set("CHARGEBEE_CONFIG_DIR", configDir);
  env.set("CHARGEBEE_SITE", "acme-test");
  env.set("CHARGEBEE_API_KEY", "test_xxx");
  env.set("CHARGEBEE_HOST", undefined);
  env.set("CHARGEBEE_REGION", undefined);
  env.set("DO_NOT_TRACK", undefined);
  env.set("CHARGEBEE_CLI_TELEMETRY", undefined);
  // A later run: the first-run notice has been shown, so events are recorded.
  writeState({ notice_shown: true });
  restoreStderrTty = setStderrIsTTY(false);
  __resetRuntimeState();
  __resetTelemetryRecorderForTest();
  __setSpawnForTest(() => ({ unref() {} }));
  __setAppsyncTableForTest({
    ".chargebee.com": { us: { dnsPrefix: "testapiid", region: "us-east-2" } },
  });
  installFakeClient({ constructions: [] });
  FakeWebSocket.instances = [];
  __setWebSocketForTest(FakeWebSocket);
  __setTunnelTimingForTest({ backoffMs: 5, maxBackoffMs: 5, closeFlushMs: 0, idleTimeoutMs: 5000 });
  __setFetchForTest(async () => new Response("ok", { status: 200 }));
});

afterEach(() => {
  __resetTelemetryRecorderForTest();
  __setSpawnForTest(null);
  __setAppsyncTableForTest(null);
  __setWebSocketForTest(null);
  __setTunnelTimingForTest(null);
  __setFetchForTest(null);
  uninstallFakeClient();
  __resetRuntimeState();
  restoreStderrTty?.();
  restoreStderrTty = undefined;
  env.restore();
  restoreCiEnv();
  rmSync(configDir, { recursive: true, force: true });
});

/** The `index`-th socket the run opens, once it has sent its first frame. */
async function socket(index: number): Promise<FakeWebSocket> {
  await waitUntil(() => FakeWebSocket.instances.length > index);
  const ws = FakeWebSocket.instances[index]!;
  await waitUntil(() => ws.sent.length > 0);
  return ws;
}

/** Close the socket before the handshake completes: a failed attempt. */
async function failAttempt(index: number): Promise<void> {
  (await socket(index)).serverClose();
}

/** Complete the handshake: a working session. */
async function subscribe(index: number): Promise<FakeWebSocket> {
  const ws = await socket(index);
  ws.emit({ type: "connection_ack" });
  await waitUntil(() => ws.parsed().some((m) => m.type === "subscribe"));
  ws.emit({ type: "subscribe_success" });
  await waitUntil(() => ws.parsed().some((m) => m.type === "publish"));
  return ws;
}

function spooledListenEvents(): SpoolRecord["event"]["metadata"][] {
  return readFileSync(spoolPath(), "utf-8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as SpoolRecord).event.metadata)
    .filter((metadata) => metadata.listen_phase !== undefined);
}

describe("chargebee listen telemetry", () => {
  it("reports failed attempts once per outage, and a recovered drop as reconnected, not an error", async () => {
    const pending = runCli(["listen", "--forward-to", "http://localhost:4000/hook"], {
      configure: (program) => installTelemetry(program, "0.0.0-test"),
    });

    try {
      // Outage 1: three attempts close before the handshake completes.
      await failAttempt(0);
      await failAttempt(1);
      await failAttempt(2);
      // Recovery: the first working session of the run.
      (await subscribe(3)).serverClose();
      // Outage 2: one attempt after the drop fails, then the next one subscribes.
      await failAttempt(4);
      // A drop straight back into a working session records only `reconnected`.
      (await subscribe(5)).serverClose();
      await subscribe(6);
    } finally {
      process.emit("SIGINT");
    }
    const { exitCode } = await pending;
    expect(exitCode).toBe(0);

    const events = spooledListenEvents();
    expect(events.map((m) => m.listen_phase)).toEqual([
      "error",
      "established",
      "error",
      "reconnected",
      "reconnected",
      "closed",
    ]);
    expect(events.filter((m) => m.listen_phase === "error").map((m) => m.err_type)).toEqual([
      "listen_connect_error",
      "listen_connect_error",
    ]);
    expect(events.filter((m) => m.listen_phase === "reconnected").map((m) => m.status)).toEqual([
      "ok",
      "ok",
    ]);
  });
});
