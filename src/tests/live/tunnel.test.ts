import { expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { cliRoot, spawnArgv, spawnEnv } from "../../lib/test-support/_spawn.js";
import { fixtureEnv, liveConfig, liveEnabled, withCustomer } from "../../lib/test-support/live.js";

it.skipIf(!liveEnabled)("US tunnel forwards a created test customer's event to the local receiver", async () => {
  const extraEnv = fixtureEnv(1);
  const dir = liveConfig();
  const received = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      try {
        const event = await request.json() as { event_type?: string; content?: { customer?: { id?: string } } };
        if (event.event_type === "customer_created" && event.content?.customer?.id) received.add(event.content.customer.id);
        return new Response("ok");
      } catch { return new Response("invalid event", { status: 400 }); }
    },
  });
  const proc = Bun.spawn({
    cmd: spawnArgv(["listen", "--forward-to", `http://127.0.0.1:${server.port}/hook`], cliRoot()),
    cwd: cliRoot(), env: spawnEnv({ configDir: dir, extraEnv }),
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let ready = false;
  let unavailable = false;
  let exited = false;
  void proc.exited.then(() => { exited = true; });
  async function consume(stream: ReadableStream<Uint8Array>) {
    let tail = "";
    for await (const chunk of stream) {
      tail = (tail + new TextDecoder().decode(chunk)).slice(-4096);
      if (tail.includes("Ready! Forwarding events")) ready = true;
      if (tail.includes("Webhook tunneling is not available")) unavailable = true;
    }
  }
  const readers = Promise.all([consume(proc.stdout), consume(proc.stderr)]);
  try {
    const readyDeadline = Date.now() + 45_000;
    while (!ready && !exited && Date.now() < readyDeadline) await Bun.sleep(100);
    if (!ready) throw new Error(unavailable
      ? "US public webhook tunnel is not configured/deployed; the forwarding scenario cannot pass until it is available"
      : "Tunnel did not become ready within 45 seconds");
    await withCustomer(1, async (id) => {
      const deadline = Date.now() + 60_000;
      while (!received.has(id) && !exited && Date.now() < deadline) await Bun.sleep(100);
      expect(received.has(id)).toBe(true);
    });
  } finally {
    try {
      // SIGINT permits the CLI's disable handshake where supported; force termination is bounded.
      proc.kill("SIGINT");
      const deadline = setTimeout(() => proc.kill("SIGKILL"), 5000);
      try { await proc.exited; await readers; }
      finally { clearTimeout(deadline); }
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 600_000);
