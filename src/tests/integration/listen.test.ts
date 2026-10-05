/**
 * Isolated CLI tests for `chargebee listen` (auth, live-site, AppSync host table).
 * Success paths use an in-process fake WebSocket + fetch stub — never AppSync.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetRuntimeState, __setClientFactory } from "../../lib/api/sdk.js";
import { writeConfig } from "../../lib/config/store.js";
import { __setAppsyncTableForTest } from "../../lib/config/urls.js";
import { __setExitForTest, __setShutdownDeadlineForTest } from "../../commands/listen.js";
import {
  __setTunnelTimingForTest,
  __setWebSocketForTest,
} from "../../lib/tunnel/appsync.js";
import { __setFetchForTest } from "../../lib/tunnel/forwarder.js";
import {
  FakeWebSocket,
  claimsFromSocket,
  handshakeFakeAppSync,
  waitUntil,
} from "../../lib/test-support/fake-websocket.js";
import {
  createEnvPatcher,
  installFakeClient,
  runCli,
  setStderrIsTTY,
  uninstallFakeClient,
  type ClientConstruction,
} from "../../lib/test-support/_helpers.js";

const env = createEnvPatcher();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function installTunnelFakes(): void {
  FakeWebSocket.instances = [];
  __setWebSocketForTest(FakeWebSocket);
  __setTunnelTimingForTest({ heartbeatMs: 20, backoffMs: 10, closeFlushMs: 0 });
  __setFetchForTest(async () => new Response("ok", { status: 200 }));
}

async function runListenUntilQuit(
  args: string[],
  signal: NodeJS.Signals = "SIGINT",
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  ws: FakeWebSocket;
}> {
  FakeWebSocket.instances = [];
  const argv = args.includes("--forward-to")
    ? args
    : ["--forward-to", "http://localhost:4000/hook", ...args];
  const pending = runCli(["listen", ...argv]);
  const ws = await handshakeFakeAppSync();
  process.emit(signal);
  const { exitCode, stdout, stderr } = await pending;
  return { exitCode, stdout, stderr, ws };
}

/** Write a profile file carrying an arbitrary `region` value straight to disk. */
async function seedProfile(name: string, region: string): Promise<void> {
  mkdirSync(join(configDir, "profiles"), { recursive: true });
  writeFileSync(
    join(configDir, "profiles", `${name}.json`),
    JSON.stringify({ site: "acme-test", api_key: "test_xxx", region }),
  );
}

/** A socket whose `close()` completes only when the test releases it — simulates an unreachable peer. */
class HeldCloseWebSocket extends FakeWebSocket {
  static release: Array<() => void> = [];
  close(): void {
    HeldCloseWebSocket.release.push(() => super.close());
  }
}

let configDir: string;
let restoreStderrTty: (() => void) | undefined;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "cb-listen-"));
  env.set("CHARGEBEE_CONFIG_DIR", configDir);
  env.set("CHARGEBEE_SITE", undefined);
  env.set("CHARGEBEE_API_KEY", undefined);
  env.set("CHARGEBEE_HOST", undefined);
  env.set("CHARGEBEE_REGION", undefined);
  restoreStderrTty = setStderrIsTTY(false);
  __resetRuntimeState();
});

afterEach(() => {
  env.restore();
  restoreStderrTty?.();
  restoreStderrTty = undefined;
  __setAppsyncTableForTest(null);
  __setWebSocketForTest(null);
  __setTunnelTimingForTest(null);
  __setFetchForTest(null);
  __setExitForTest(null);
  __setShutdownDeadlineForTest(null);
  uninstallFakeClient();
  __resetRuntimeState();
  rmSync(configDir, { recursive: true, force: true });
});

describe("chargebee listen", () => {
  it("streams JSON forwarding metadata and shutdown without webhook payloads", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "testapiid", region: "us-east-2" } },
    });
    installTunnelFakes();
    installFakeClient({ constructions: [] });
    let forwards = 0;
    __setFetchForTest(async () => { forwards++; return new Response("ok", { status: 201 }); });
    const pending = runCli(["listen", "--forward-to", "http://localhost:4000/hook", "--json"]);
    const ws = await handshakeFakeAppSync();
    ws.emit({ type: "data", event: JSON.stringify({ event_type: "customer_created", content: { private_fixture: "do-not-print" } }) });
    await waitUntil(() => forwards === 1);
    process.emit("SIGINT");
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const records = result.stdout.split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.type)).toEqual(["connecting", "ready", "forward_result", "stopped"]);
    expect(records[2]).toMatchObject({ event_type: "customer_created", http_status: 201 });
    expect(result.stdout).not.toContain("do-not-print");
    expect(result.stdout).not.toContain("test_xxx");
    expect(result.stdout).not.toContain("appsync");
  });

  it("does not connect when --forward-to is omitted", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    installTunnelFakes();
    FakeWebSocket.instances = [];
    const { stderr, stdout, exitCode } = await runCli(["listen"]);
    expect(exitCode).not.toBe(0);
    expect(`${stderr}\n${stdout}`).toMatch(/required option .*--forward-to/);
    expect(`${stderr}\n${stdout}`).not.toContain("Ready!");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("is a registered develop command", async () => {
    const { stdout, exitCode } = await runCli(["listen", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Forward webhook events on your local machine");
    expect(stdout).toContain("--forward-to");
  });

  it("refuses to listen on a live site", async () => {
    env.set("CHARGEBEE_SITE", "acme");
    env.set("CHARGEBEE_API_KEY", "live_xxx");
    const { stderr, stdout, exitCode } = await runCli(["listen", "--forward-to", "http://localhost:4000/hook"]);
    expect(exitCode).toBe(1);
    expect(`${stderr}\n${stdout}`).toContain("live site");
    expect(`${stderr}\n${stdout}`).not.toContain("Connecting to");
  });

  it("fails closed when the AppSync API is not hardcoded for the host", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({});
    const { stderr, stdout, exitCode } = await runCli(["listen", "--forward-to", "http://localhost:4000/hook"]);
    expect(exitCode).toBe(1);
    expect(`${stderr}\n${stdout}`).toContain(
      "Webhook tunneling is not available",
    );
    expect(`${stderr}\n${stdout}`).not.toContain("Connecting to");
  });

  it("connects to the AppSync deployment for the active profile's region", async () => {
    await seedProfile("eu-prof", "eu");
    await writeConfig({ domain: "acme-test", activeProfile: "eu-prof" });
    __setAppsyncTableForTest({
      ".chargebee.com": {
        us: { dnsPrefix: "usid", region: "us-east-1" },
        eu: { dnsPrefix: "euid", region: "eu-central-1" },
      },
    });
    installTunnelFakes();
    installFakeClient({ constructions: [] });

    const { exitCode, stdout, stderr, ws } = await runListenUntilQuit([]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("> Initiating webhook tunnel...");
    expect(stdout).not.toContain("Initiating webhook tunnel");
    expect(ws.url).toBe(
      "wss://euid.appsync-realtime-api.eu-central-1.amazonaws.com/event/realtime",
    );
  });

  it("takes no --region flag; the profile is the only source", async () => {
    const { stderr, exitCode } = await runCli([
      "listen",
      "--forward-to",
      "http://localhost:4000/hook",
      "--region",
      "eu",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown option");
  });

  it("defaults to the us tunnel endpoint", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({
      ".chargebee.com": {
        us: { dnsPrefix: "usid", region: "us-east-1" },
        eu: { dnsPrefix: "euid", region: "eu-central-1" },
      },
    });
    installTunnelFakes();
    installFakeClient({ constructions: [] });

    const { exitCode, ws } = await runListenUntilQuit([]);
    expect(exitCode).toBe(0);
    expect(ws.url).toBe(
      "wss://usid.appsync-realtime-api.us-east-1.amazonaws.com/event/realtime",
    );
  });

  it("takes the region from the profile named by --use-profile", async () => {
    await seedProfile("eu-prof", "eu");
    __setAppsyncTableForTest({
      ".chargebee.com": {
        us: { dnsPrefix: "usid", region: "us-east-1" },
        eu: { dnsPrefix: "euid", region: "eu-central-1" },
      },
    });
    installTunnelFakes();
    installFakeClient({ constructions: [] });

    FakeWebSocket.instances = [];
    const pending = runCli([
      "--use-profile",
      "eu-prof",
      "listen",
      "--forward-to",
      "http://localhost:4000/hook",
    ]);
    const ws = await handshakeFakeAppSync();
    process.emit("SIGINT");
    const { exitCode } = await pending;

    expect(exitCode).toBe(0);
    expect(ws.url).toBe(
      "wss://euid.appsync-realtime-api.eu-central-1.amazonaws.com/event/realtime",
    );
  });

  it("honors CHARGEBEE_REGION", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    env.set("CHARGEBEE_REGION", "eu");
    __setAppsyncTableForTest({
      ".chargebee.com": {
        us: { dnsPrefix: "usid", region: "us-east-1" },
        eu: { dnsPrefix: "euid", region: "eu-central-1" },
      },
    });
    installTunnelFakes();
    installFakeClient({ constructions: [] });

    const { exitCode, ws } = await runListenUntilQuit([]);
    expect(exitCode).toBe(0);
    expect(ws.url).toBe(
      "wss://euid.appsync-realtime-api.eu-central-1.amazonaws.com/event/realtime",
    );
  });

  it("fails closed, naming the deployed regions, when the site's region has no AppSync", async () => {
    await seedProfile("au-prof", "au");
    await writeConfig({ domain: "acme-test", activeProfile: "au-prof" });
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "usid", region: "us-east-1" } },
    });
    const { stderr, stdout, exitCode } = await runCli(["listen", "--forward-to", "http://localhost:4000/hook"]);
    expect(exitCode).toBe(1);
    const out = `${stderr}\n${stdout}`;
    expect(out).toContain('"au"');
    expect(out).toContain("Available: us");
    expect(out).toContain("auth add --region");
    expect(out).not.toContain("Connecting to");
  });

  it("rejects an invalid CHARGEBEE_REGION before any API call", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    env.set("CHARGEBEE_REGION", "eu-central-1");
    const constructions: ClientConstruction[] = [];
    installFakeClient({ constructions });
    const { stderr, stdout, exitCode } = await runCli(["listen", "--forward-to", "http://localhost:4000/hook"]);
    expect(exitCode).toBe(1);
    expect(`${stderr}\n${stdout}`).toContain("Invalid region");
    expect(constructions).toHaveLength(0);
  });

  it("reports an invalid saved region instead of silently using us", async () => {
    await seedProfile("broken", "uk");
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "usid", region: "us-east-1" } },
    });
    const { stderr, stdout, exitCode } = await runCli([
      "--use-profile",
      "broken",
      "listen",
      "--forward-to",
      "http://localhost:4000/hook",
    ]);
    expect(exitCode).toBe(1);
    expect(`${stderr}\n${stdout}`).toContain("Invalid region");
  });

  it("fails fast with a clear message when the runtime has no WebSocket global", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "testapiid", region: "us-east-2" } },
    });
    const constructions: ClientConstruction[] = [];
    installFakeClient({ constructions });

    const g = globalThis as { WebSocket?: unknown };
    const savedWebSocket = g.WebSocket;
    delete g.WebSocket;
    try {
      const { stderr, stdout, exitCode } = await runCli(["listen", "--forward-to", "http://localhost:4000/hook"]);
      expect(exitCode).toBe(1);
      expect(`${stderr}\n${stdout}`).toContain(
        "chargebee listen requires Node 22+ or the standalone binary",
      );
      expect(`${stderr}\n${stdout}`).not.toContain("WebSocket is not defined");
      expect(`${stderr}\n${stdout}`).not.toContain("Reconnecting");
      // Checked before any API call (no catalog detection) and no socket.
      expect(constructions).toHaveLength(0);
    } finally {
      g.WebSocket = savedWebSocket;
    }
  });

  it("exits when nothing is configured", async () => {
    const { stderr, stdout, exitCode } = await runCli(["listen", "--forward-to", "http://localhost:4000/hook"]);
    expect(exitCode).toBe(1);
    expect(`${stderr}\n${stdout}`).toContain("Not configured");
  });

  it("surfaces detectCatalog auth errors once endpoints exist", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "testapiid", region: "us-east-2" } },
    });
    __setClientFactory(
      () =>
        ({
          configuration: {
            list: async () => {
              throw { http_status_code: 401, message: "unauthorized" };
            },
          },
        }) as never,
    );

    const { stderr, stdout, exitCode } = await runCli(["listen", "--forward-to", "http://localhost:4000/hook"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("> Initiating webhook tunnel...");
    expect(`${stderr}\n${stdout}`).toContain('Invalid API key for "acme-test"');
  });

  it("prefixes http:// and derives dual-mode from v1+compat", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "testapiid", region: "us-east-2" } },
    });
    installTunnelFakes();
    installFakeClient({
      constructions: [],
      catalogBySite: { "acme-test": { pcv: "v1", schema: "compat" } },
    });

    const { exitCode, stderr, stdout, ws } = await runListenUntilQuit([
      "--forward-to",
      "localhost:4000/hook",
    ]);

    const session = String(claimsFromSocket(ws).session_id);
    expect(session).toMatch(UUID_RE);
    expect(exitCode).toBe(0);
    expect(ws.url).toBe(
      "wss://testapiid.appsync-realtime-api.us-east-2.amazonaws.com/event/realtime",
    );
    expect(ws.parsed().find((m) => m.type === "subscribe")?.channel).toBe(
      `/webhooks/${session}`,
    );
    expect(claimsFromSocket(ws)).toMatchObject({
      site: "acme-test",
      api_key: "test_xxx",
      session_id: session,
      chargebee_response_schema_type: "compat",
      is_dual_mode: true,
    });
    expect(
      ws
        .parsed()
        .some(
          (m) =>
            m.type === "publish" &&
            (m.events as string[])?.[0] === '{"op":"disable"}',
        ),
    ).toBe(true);
    expect(ws.parsed().every((m) => m.type !== "unsubscribe")).toBe(true);
    expect(stdout).toContain(
      "> Ready! Forwarding events to http://localhost:4000/hook",
    );
    expect(`${stderr}\n${stdout}`).not.toContain("Connecting to");
    expect(`${stderr}\n${stdout}`).not.toContain("appsync");
  });

  it("keeps an explicit URL and treats PCV2 as not dual-mode", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "testapiid", region: "us-east-2" } },
    });
    installTunnelFakes();
    installFakeClient({
      constructions: [],
      catalogBySite: { "acme-test": { pcv: "v2", schema: "items" } },
    });

    const httpsRun = await runListenUntilQuit([
      "--forward-to",
      "https://127.0.0.1:9/wh",
    ]);
    expect(httpsRun.exitCode).toBe(0);
    expect(httpsRun.stdout).toContain(
      "> Ready! Forwarding events to https://127.0.0.1:9/wh",
    );
    expect(claimsFromSocket(httpsRun.ws).is_dual_mode).toBe(false);
    expect(claimsFromSocket(httpsRun.ws).chargebee_response_schema_type).toBe(
      "items",
    );

    const defaultRun = await runListenUntilQuit([]);
    expect(defaultRun.exitCode).toBe(0);
    expect(defaultRun.stdout).toContain(
      "> Ready! Forwarding events to http://localhost:4000/hook",
    );
    const defaultSession = String(claimsFromSocket(defaultRun.ws).session_id);
    expect(defaultSession).toMatch(UUID_RE);
    expect(defaultSession).not.toBe(
      String(claimsFromSocket(httpsRun.ws).session_id),
    );

    const portRun = await runListenUntilQuit(["--forward-to", "4001"]);
    expect(portRun.exitCode).toBe(0);
    expect(portRun.stdout).toContain(
      "> Ready! Forwarding events to http://localhost:4001",
    );
  });

  it("rejects a relative --forward-to path before connecting", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "testapiid", region: "us-east-2" } },
    });
    installTunnelFakes();
    installFakeClient({ constructions: [] });

    FakeWebSocket.instances = [];
    const { stderr, stdout, exitCode } = await runCli([
      "listen",
      "--forward-to",
      "/webhook",
    ]);
    expect(exitCode).toBe(1);
    expect(`${stderr}\n${stdout}`).toContain("--forward-to");
    expect(`${stderr}\n${stdout}`).not.toContain("Ready!");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("rejects an invalid --forward-to scheme before connecting", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "testapiid", region: "us-east-2" } },
    });
    installTunnelFakes();
    installFakeClient({ constructions: [] });

    FakeWebSocket.instances = [];
    const { stderr, stdout, exitCode } = await runCli([
      "listen",
      "--forward-to",
      "httpfoo:3000",
    ]);
    expect(exitCode).toBe(1);
    expect(`${stderr}\n${stdout}`).toContain("--forward-to");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("exits 1 with the reason, without retrying, when the authorizer rejects the session", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "testapiid", region: "us-east-2" } },
    });
    installTunnelFakes();
    installFakeClient({ constructions: [] });

    FakeWebSocket.instances = [];
    const pending = runCli(["listen", "--forward-to", "http://localhost:4000/hook"]);
    await waitUntil(() => (FakeWebSocket.instances[0]?.sent.length ?? 0) > 0);
    const ws = FakeWebSocket.instances[0]!;
    ws.emit({ type: "connection_ack" });
    await waitUntil(() => ws.parsed().some((m) => m.type === "subscribe"));
    ws.emit({
      type: "subscribe_error",
      errors: [{ errorType: "UnauthorizedException", message: "token expired" }],
    });

    const { exitCode, stdout, stderr } = await pending;
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Could not authorize the listen session.");
    expect(stderr).not.toMatch(/AppSync|UnauthorizedException|lambda invocation/i);
    expect(stderr).not.toContain("chargebee auth add");
    expect(stderr).not.toContain("API key was rejected");
    expect(`${stderr}\n${stdout}`).not.toContain("Reconnecting");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("treats an AppSync authorizer timeout as the same opaque 401", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "testapiid", region: "us-east-2" } },
    });
    installTunnelFakes();
    installFakeClient({ constructions: [] });

    FakeWebSocket.instances = [];
    const pending = runCli(["listen", "--forward-to", "http://localhost:4000/hook"]);
    await waitUntil(() => (FakeWebSocket.instances[0]?.sent.length ?? 0) > 0);
    const ws = FakeWebSocket.instances[0]!;
    ws.emit({
      type: "connection_error",
      errors: [
        {
          errorType: "UnauthorizedException",
          message:
            "You are not authorized to make this call because the lambda invocation timed out.",
          errorCode: 401,
        },
      ],
    });

    const { exitCode, stdout, stderr } = await pending;
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Could not authorize the listen session.");
    expect(stderr).not.toMatch(/AppSync|UnauthorizedException|lambda invocation|authorizer/i);
    expect(stderr).not.toContain("chargebee auth add");
    expect(stderr).not.toContain("API key was rejected");
    expect(`${stderr}\n${stdout}`).not.toContain("Reconnecting");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("exits 1 with ENABLE_FAILED when onSubscribe cannot register the session", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "testapiid", region: "us-east-2" } },
    });
    installTunnelFakes();
    installFakeClient({ constructions: [] });

    FakeWebSocket.instances = [];
    const pending = runCli(["listen", "--forward-to", "http://localhost:4000/hook"]);
    await waitUntil(() => (FakeWebSocket.instances[0]?.sent.length ?? 0) > 0);
    const ws = FakeWebSocket.instances[0]!;
    ws.emit({ type: "connection_ack" });
    await waitUntil(() => ws.parsed().some((m) => m.type === "subscribe"));
    ws.emit({
      type: "subscribe_error",
      errors: [{ message: "ENABLE_FAILED:401" }],
    });

    const { exitCode, stdout, stderr } = await pending;
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Could not register the listen session with Chargebee (HTTP 401).");
    expect(stderr).not.toMatch(/AppSync|ENABLE_FAILED/i);
    expect(stderr).not.toContain("chargebee auth add");
    expect(`${stderr}\n${stdout}`).not.toContain("Reconnecting");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("warns once on stderr when --forward-to targets a non-loopback host", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "testapiid", region: "us-east-2" } },
    });
    installTunnelFakes();
    installFakeClient({ constructions: [] });

    const { stderr, stdout } = await runListenUntilQuit([
      "--forward-to",
      "https://example.com/hook",
    ]);
    expect(stdout).toContain(
      "> Ready! Forwarding events to https://example.com/hook",
    );
    expect(stderr).toContain("non-loopback host (example.com)");
    expect(stderr.match(/non-loopback host/g) ?? []).toHaveLength(1);
  });

  it("publishes disable and quits cleanly on SIGHUP", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "testapiid", region: "us-east-2" } },
    });
    installTunnelFakes();
    installFakeClient({ constructions: [] });

    const { exitCode, ws } = await runListenUntilQuit([], "SIGHUP");
    expect(exitCode).toBe(0);
    expect(
      ws
        .parsed()
        .some(
          (m) =>
            m.type === "publish" &&
            (m.events as string[])?.[0] === '{"op":"disable"}',
        ),
    ).toBe(true);
  });

  it("forces an exit after the shutdown deadline when the peer never closes", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "testapiid", region: "us-east-2" } },
    });
    installTunnelFakes();
    HeldCloseWebSocket.release = [];
    __setWebSocketForTest(HeldCloseWebSocket);
    installFakeClient({ constructions: [] });

    const exitCalls: number[] = [];
    __setExitForTest((code) => exitCalls.push(code));
    __setShutdownDeadlineForTest(10);

    FakeWebSocket.instances = [];
    const pending = runCli(["listen", "--forward-to", "http://localhost:4000/hook"]);
    await handshakeFakeAppSync();
    process.emit("SIGINT");
    await waitUntil(() => exitCalls.length > 0);
    expect(exitCalls).toEqual([1]);

    for (const complete of HeldCloseWebSocket.release) complete();
    const { exitCode } = await pending;
    expect(exitCode).toBe(0);
    expect(exitCalls).toEqual([1]);
  });

  it.each([false, true])("a second SIGINT during shutdown exits immediately (json: %s)", async (json) => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "testapiid", region: "us-east-2" } },
    });
    installTunnelFakes();
    installFakeClient({ constructions: [] });

    const exitCalls: number[] = [];
    __setExitForTest((code) => exitCalls.push(code));

    FakeWebSocket.instances = [];
    const pending = runCli(["listen", "--forward-to", "http://localhost:4000/hook", ...(json ? ["--json"] : [])]);
    await handshakeFakeAppSync();
    process.emit("SIGINT");
    process.emit("SIGINT");
    const result = await pending;
    if (json) {
      expect(JSON.parse(result.stderr).error).toMatchObject({ code: "shutdown_failed", exit_code: 130 });
      expect(result.stdout).not.toContain("stopped");
    }

    expect(exitCalls).toEqual([130]);
  });

  it("shutdown deadline uses the default process.exit wrapper", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    __setAppsyncTableForTest({
      ".chargebee.com": { us: { dnsPrefix: "testapiid", region: "us-east-2" } },
    });
    installTunnelFakes();
    HeldCloseWebSocket.release = [];
    __setWebSocketForTest(HeldCloseWebSocket);
    installFakeClient({ constructions: [] });

    __setShutdownDeadlineForTest(10);

    FakeWebSocket.instances = [];
    const pending = runCli(["listen", "--forward-to", "http://localhost:4000/hook"]);
    await handshakeFakeAppSync();
    process.emit("SIGINT");
    await Bun.sleep(40);
    for (const complete of HeldCloseWebSocket.release) complete();
    const { exitCode } = await pending;
    expect(exitCode).toBe(0);
  });
});
