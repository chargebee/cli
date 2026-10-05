import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { BATCH_SIZE, ENV_FLUSH_CHILD, FLUSH_COMMAND, spoolPath } from "../../../../lib/telemetry/constants.js";
import {
  __finalizeForTest,
  __resetTelemetryRecorderForTest,
  __setSpawnForTest,
  emitListenPhase,
  ignoreFailedAuthLookup,
  installTelemetry,
  productionHostFallback,
} from "../../../../lib/telemetry/index.js";
import { PRODUCTION_HOST } from "../../../../lib/config/host.js";
import { appendRecord } from "../../../../lib/telemetry/spool.js";
import { setTelemetryEnabled } from "../../../../lib/telemetry/optout.js";
import { readState, writeState } from "../../../../lib/telemetry/state.js";
import { recordTelemetryError, takeTelemetryError } from "../../../../lib/telemetry/error.js";
import type { SpoolRecord } from "../../../../lib/telemetry/types.js";
import { __resetKeychainForTest, __setKeychainForTest, type KeychainStore } from "../../../../lib/config/keychain.js";
import { saveProfile } from "../../../../lib/config/profiles.js";
import { writeConfig } from "../../../../lib/config/store.js";
import { __resetRuntimeState } from "../../../../lib/api/sdk.js";

function sample(over: Partial<SpoolRecord> = {}): SpoolRecord {
  return {
    env: "production",
    site_name: "acme-test",
    visitor_id: "vid",
    cli_version: "1.0.0",
    event: { name: "seed", timestamp: new Date().toISOString(), metadata: {} },
    ...over,
  };
}

import { clearCiEnv } from "../../../../lib/test-support/_helpers.js";

// The recorder is disabled on a CI runner; these tests exercise it, so clear CI detection.
let restoreCiEnv: () => void = () => undefined;
beforeEach(() => {
  restoreCiEnv = clearCiEnv();
});
afterEach(() => restoreCiEnv());

describe("installTelemetry recorder", () => {
  const prevDir = process.env.CHARGEBEE_CONFIG_DIR;
  const prevFlush = process.env[ENV_FLUSH_CHILD];
  const origArgv = process.argv.slice();
  const origExit = process.exit;
  let dir: string;
  let spawns: string[][] = [];
  let spawnOpts: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-recorder-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    delete process.env[ENV_FLUSH_CHILD];
    // Simulate a later run: the first-run notice has already been shown.
    writeState({ notice_shown: true });
    spawns = [];
    spawnOpts = [];
    takeTelemetryError();
    __resetTelemetryRecorderForTest();
    __setSpawnForTest((cmd, args, opts) => {
      spawns.push([cmd, ...args]);
      spawnOpts.push(opts as Record<string, unknown>);
      return { unref() {} };
    });
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as typeof process.exit;
  });

  afterEach(() => {
    __resetTelemetryRecorderForTest();
    __setSpawnForTest(null);
    process.argv = origArgv;
    process.exit = origExit;
    rmSync(dir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prevDir;
    if (prevFlush === undefined) delete process.env[ENV_FLUSH_CHILD];
    else process.env[ENV_FLUSH_CHILD] = prevFlush;
  });

  it("auth lookup fallbacks keep begin() from rejecting", () => {
    expect(ignoreFailedAuthLookup()).toBeUndefined();
    expect(productionHostFallback()).toEqual(PRODUCTION_HOST);
  });

  it("does not install hooks in the flush child", async () => {
    process.env[ENV_FLUSH_CHILD] = "1";
    const program = new Command();
    program.exitOverride();
    program.command("ping").action(() => undefined);
    installTelemetry(program, "0.0.0-test");
    await program.parseAsync(["ping"], { from: "user" });
    __finalizeForTest(0);
    expect(() => readFileSync(spoolPath(), "utf-8")).toThrow();
  });

  it("spools an event for a successful command and records flag names", async () => {
    const program = new Command();
    program.exitOverride();
    program.option("--use-profile <profile>");
    program.command("ping").action(() => undefined);
    installTelemetry(program, "9.9.9-test");
    await program.parseAsync(["--use-profile", "default", "ping"], { from: "user" });
    __finalizeForTest(0);
    const lines = readFileSync(spoolPath(), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]) as SpoolRecord;
    expect(rec.cli_version).toBe("9.9.9-test");
    expect(rec.event.name).toBe("ping");
    expect(rec.visitor_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(rec.event.metadata.status).toBe("ok");
  });

  it("spawns a flush child once the spool hits BATCH_SIZE", async () => {
    for (let i = 0; i < BATCH_SIZE - 1; i++) appendRecord(sample({ event: { name: `n${i}`, timestamp: new Date().toISOString(), metadata: {} } }));
    const program = new Command();
    program.exitOverride();
    program.command("ping").action(() => undefined);
    installTelemetry(program, "1.0.0-test");
    await program.parseAsync(["ping"], { from: "user" });
    __finalizeForTest(0);
    expect(spawns.length).toBeGreaterThanOrEqual(1);
    expect(spawns[0].some((a) => a === FLUSH_COMMAND || a.endsWith(FLUSH_COMMAND))).toBe(true);
  });

  it("does not spawn a flush child while backing off after a prior failure (#126)", async () => {
    for (let i = 0; i < BATCH_SIZE - 1; i++) appendRecord(sample({ event: { name: `n${i}`, timestamp: new Date().toISOString(), metadata: {} } }));
    writeState({ consecutive_flush_failures: 1, next_flush_attempt_at: Date.now() + 60_000 });
    const program = new Command();
    program.exitOverride();
    program.command("ping").action(() => undefined);
    installTelemetry(program, "1.0.0-test");
    await program.parseAsync(["ping"], { from: "user" });
    __finalizeForTest(0);
    expect(spawns).toHaveLength(0);
  });

  it("spawns a flush child once the backoff window has passed", async () => {
    for (let i = 0; i < BATCH_SIZE - 1; i++) appendRecord(sample({ event: { name: `n${i}`, timestamp: new Date().toISOString(), metadata: {} } }));
    writeState({ consecutive_flush_failures: 1, next_flush_attempt_at: Date.now() - 1000 });
    const program = new Command();
    program.exitOverride();
    program.command("ping").action(() => undefined);
    installTelemetry(program, "1.0.0-test");
    await program.parseAsync(["ping"], { from: "user" });
    __finalizeForTest(0);
    expect(spawns.length).toBeGreaterThanOrEqual(1);
  });

  it("does not record when telemetry is disabled", async () => {
    setTelemetryEnabled(false);
    const program = new Command();
    program.exitOverride();
    program.command("ping").action(() => undefined);
    installTelemetry(program, "1.0.0-test");
    await program.parseAsync(["ping"], { from: "user" });
    __finalizeForTest(0);
    expect(() => readFileSync(spoolPath(), "utf-8")).toThrow();
  });

  it("seeds a usage event on parse failure", async () => {
    const program = new Command();
    program.command("ping").action(() => undefined);
    installTelemetry(program, "1.0.0-test");
    process.argv = ["bun", "chargebee", "nope"];
    try {
      await program.parseAsync(["nope"], { from: "user" });
    } catch {
      // process.exit stub throws
    }
    __finalizeForTest(1);
    const rec = JSON.parse(readFileSync(spoolPath(), "utf-8").trim()) as SpoolRecord;
    expect(rec.event.metadata.status).toBe("error");
    expect(rec.event.metadata.err_type).toBe("usage");
  });

  it("records nonzero_exit when finalize is called with a failing code", async () => {
    const program = new Command();
    program.exitOverride();
    program.command("ping").action(() => undefined);
    installTelemetry(program, "1.0.0-test");
    await program.parseAsync(["ping"], { from: "user" });
    __finalizeForTest(2);
    const rec = JSON.parse(readFileSync(spoolPath(), "utf-8").trim()) as SpoolRecord;
    expect(rec.event.metadata.status).toBe("error");
    expect(rec.event.metadata.err_type).toBe("nonzero_exit");
  });

  it("spools listen established/error/closed, flushes immediately, and skips the generic exit event", async () => {
    const program = new Command();
    program.exitOverride();
    program.command("listen").action(() => {
      emitListenPhase("established");
      emitListenPhase("error", "listen_connect_error");
      emitListenPhase("closed");
    });
    installTelemetry(program, "1.0.0-test");
    await program.parseAsync(["listen"], { from: "user" });
    __finalizeForTest(0);
    const records = readFileSync(spoolPath(), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SpoolRecord);
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.event.metadata.listen_phase)).toEqual([
      "established",
      "error",
      "closed",
    ]);
    expect(records[1]?.event.metadata.err_type).toBe("listen_connect_error");
    expect(records[1]?.event.metadata.status).toBe("error");
    expect(records[0]?.event.metadata.status).toBe("ok");
    expect(records[2]?.event.metadata.status).toBe("ok");
    for (const rec of records) {
      expect(rec.event.name).toBe("listen");
      expect("dur_ms" in rec.event.metadata).toBe(false);
    }
    expect(spawns.length).toBeGreaterThanOrEqual(3);
  });

  it("omits dur_ms and records listen_live_blocked when listen fails before connecting", async () => {
    const program = new Command();
    program.exitOverride();
    program.command("listen").action(() => {
      recordTelemetryError("listen_live_blocked");
    });
    installTelemetry(program, "1.0.0-test");
    await program.parseAsync(["listen"], { from: "user" });
    __finalizeForTest(1);
    const rec = JSON.parse(readFileSync(spoolPath(), "utf-8").trim()) as SpoolRecord;
    expect(rec.event.name).toBe("listen");
    expect(rec.event.metadata.err_type).toBe("listen_live_blocked");
    expect("listen_phase" in rec.event.metadata).toBe(false);
    expect("dur_ms" in rec.event.metadata).toBe(false);
  });

  it("swallows spawn failures so the command still finishes", async () => {
    for (let i = 0; i < BATCH_SIZE - 1; i++) {
      appendRecord(sample({ event: { name: `n${i}`, timestamp: new Date().toISOString(), metadata: {} } }));
    }
    __setSpawnForTest(() => {
      throw new Error("spawn failed");
    });
    const program = new Command();
    program.exitOverride();
    program.command("ping").action(() => undefined);
    installTelemetry(program, "1.0.0-test");
    await program.parseAsync(["ping"], { from: "user" });
    expect(() => __finalizeForTest(0)).not.toThrow();
  });

  describe("first run (#114)", () => {
    function pingProgram(): Command {
      const program = new Command();
      program.exitOverride();
      program.command("ping").action(() => undefined);
      installTelemetry(program, "1.0.0-test");
      return program;
    }

    it("shows the notice and records nothing on that run; the next run records", async () => {
      writeState({ notice_shown: false }); // fresh install
      const writes: string[] = [];
      const orig = process.stderr.write.bind(process.stderr);
      (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
        writes.push(String(c));
        return true;
      };
      try {
        await pingProgram().parseAsync(["ping"], { from: "user" });
        __finalizeForTest(0);
      } finally {
        process.stderr.write = orig;
      }
      expect(writes.join("")).toContain("chargebee telemetry disable");
      expect(readState().notice_shown).toBe(true);
      // The user has not had a chance to opt out yet: nothing is spooled.
      expect(() => readFileSync(spoolPath(), "utf-8")).toThrow();

      // Second run (new process): records normally.
      __resetTelemetryRecorderForTest();
      await pingProgram().parseAsync(["ping"], { from: "user" });
      __finalizeForTest(0);
      const lines = readFileSync(spoolPath(), "utf-8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect((JSON.parse(lines[0]) as SpoolRecord).event.name).toBe("ping");
    });

    it("does not seed a usage event before the notice has ever been shown", async () => {
      writeState({ notice_shown: false });
      const program = new Command();
      program.command("ping").action(() => undefined);
      installTelemetry(program, "1.0.0-test");
      process.argv = ["bun", "chargebee", "nope"];
      try {
        await program.parseAsync(["nope"], { from: "user" });
      } catch {
        // process.exit stub throws
      }
      __finalizeForTest(1);
      expect(() => readFileSync(spoolPath(), "utf-8")).toThrow();
    });
  });

  describe("flush child launch modes (#113)", () => {
    /** Seed BATCH_SIZE-1 records, run one command, finalize: exactly one spawnFlush(). */
    async function triggerFlush(): Promise<void> {
      for (let i = 0; i < BATCH_SIZE - 1; i++) {
        appendRecord(sample({ event: { name: `n${i}`, timestamp: new Date().toISOString(), metadata: {} } }));
      }
      const program = new Command();
      program.exitOverride();
      program.command("ping").action(() => undefined);
      installTelemetry(program, "1.0.0-test");
      await program.parseAsync(["ping"], { from: "user" });
      __finalizeForTest(0);
      expect(spawns).toHaveLength(1);
    }

    it("npm global install: resolves the extensionless bin symlink to dist/index.js", async () => {
      // Mirrors `npm i -g`: /usr/local/bin/chargebee -> ../lib/node_modules/@chargebee/cli/dist/index.js,
      // and Node leaves process.argv[1] as the (unresolved) symlink path.
      const script = join(dir, "lib", "node_modules", "@chargebee", "cli", "dist", "index.js");
      mkdirSync(dirname(script), { recursive: true });
      writeFileSync(script, "#!/usr/bin/env node\n");
      const bin = join(dir, "bin", "chargebee");
      mkdirSync(dirname(bin), { recursive: true });
      symlinkSync(script, bin);
      process.argv = [process.execPath, bin, "ping"];

      await triggerFlush();
      expect(spawns[0]).toEqual([process.execPath, realpathSync(script), FLUSH_COMMAND]);
    });

    it("compiled binary: argv[1] is Bun's virtual entry, so the child is execPath alone", async () => {
      process.argv = [process.execPath, "/$bunfs/root/chargebee-cli", "ping"];
      await triggerFlush();
      expect(spawns[0]).toEqual([process.execPath, FLUSH_COMMAND]);
    });

    it("compiled binary: argv[1] equal to execPath is not passed as a script", async () => {
      process.argv = [process.execPath, process.execPath, "ping"];
      await triggerFlush();
      expect(spawns[0]).toEqual([process.execPath, FLUSH_COMMAND]);
    });

    it("dev mode: passes the .ts entry through", async () => {
      const script = join(dir, "src", "index.ts");
      mkdirSync(dirname(script), { recursive: true });
      writeFileSync(script, "");
      process.argv = [process.execPath, script, "ping"];
      await triggerFlush();
      expect(spawns[0]).toEqual([process.execPath, realpathSync(script), FLUSH_COMMAND]);
    });

    it("detaches the child so it outlives the parent", async () => {
      process.argv = [process.execPath, "/$bunfs/root/chargebee-cli", "ping"];
      await triggerFlush();
      const opts = spawnOpts[0];
      expect(opts.detached).toBe(true);
      expect(opts.stdio).toBe("ignore");
      expect(opts.windowsHide).toBe(true);
      expect((opts.env as NodeJS.ProcessEnv)[ENV_FLUSH_CHILD]).toBe("1");
    });
  });

  describe("site_name labeling never touches the OS keychain (#125)", () => {
    const prevSite = process.env.CHARGEBEE_SITE;
    const prevKey = process.env.CHARGEBEE_API_KEY;

    function countingStore(): KeychainStore & { calls: number } {
      return {
        calls: 0,
        async get() {
          this.calls++;
          throw new Error("keychain must never be read for telemetry");
        },
        async set() {
          /* unused */
        },
        async delete() {
          /* unused */
        },
      };
    }

    afterEach(() => {
      __resetKeychainForTest();
      __resetRuntimeState();
      if (prevSite === undefined) delete process.env.CHARGEBEE_SITE;
      else process.env.CHARGEBEE_SITE = prevSite;
      if (prevKey === undefined) delete process.env.CHARGEBEE_API_KEY;
      else process.env.CHARGEBEE_API_KEY = prevKey;
    });

    async function recordOneCommand(): Promise<SpoolRecord> {
      const program = new Command();
      program.exitOverride();
      program.command("skills").action(() => undefined);
      installTelemetry(program, "1.0.0-test");
      await program.parseAsync(["skills"], { from: "user" });
      __finalizeForTest(0);
      return JSON.parse(readFileSync(spoolPath(), "utf-8").trim()) as SpoolRecord;
    }

    it("never calls the key store for a non-API command, even with a keychain-backed active profile", async () => {
      const store = countingStore();
      __setKeychainForTest(store);
      await saveProfile("prod", { site: "acme-test", api_key: "live_secret" });
      await writeConfig({ domain: "acme-test", activeProfile: "prod" });

      const rec = await recordOneCommand();
      expect(store.calls).toBe(0);
      expect(rec.site_name).toBe("acme-test");
    });

    it("labels site_name from CHARGEBEE_SITE/CHARGEBEE_API_KEY without reading a profile", async () => {
      process.env.CHARGEBEE_SITE = "env-test";
      process.env.CHARGEBEE_API_KEY = "live_env_secret";
      const rec = await recordOneCommand();
      expect(rec.site_name).toBe("env-test");
    });
  });
});
