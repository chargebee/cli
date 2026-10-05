import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearCiEnv, runCli } from "../../lib/test-support/_helpers.js";
import { ENV_FLUSH_CHILD, FLUSH_COMMAND } from "../../lib/telemetry/constants.js";
import { appendRecord } from "../../lib/telemetry/spool.js";
import { writeState } from "../../lib/telemetry/state.js";

// Exercise telemetry behavior independently of CI detection.
let restoreCiEnv: () => void = () => undefined;
beforeEach(() => {
  restoreCiEnv = clearCiEnv();
});
afterEach(() => restoreCiEnv());

describe("telemetry status", () => {
  let configDir: string | undefined;
  const prevConfigDir = process.env.CHARGEBEE_CONFIG_DIR;
  const prevDoNotTrack = process.env.DO_NOT_TRACK;
  const prevCliTelemetry = process.env.CHARGEBEE_CLI_TELEMETRY;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "cb-telemetry-status-"));
    process.env.CHARGEBEE_CONFIG_DIR = configDir;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CHARGEBEE_CLI_TELEMETRY;
  });

  afterEach(() => {
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    if (prevConfigDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prevConfigDir;
    if (prevDoNotTrack === undefined) delete process.env.DO_NOT_TRACK;
    else process.env.DO_NOT_TRACK = prevDoNotTrack;
    if (prevCliTelemetry === undefined) delete process.env.CHARGEBEE_CLI_TELEMETRY;
    else process.env.CHARGEBEE_CLI_TELEMETRY = prevCliTelemetry;
  });

  it("bare telemetry command prints the same status as telemetry status", async () => {
    const { stdout, exitCode } = await runCli(["telemetry"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Telemetry");
    expect(stdout).toContain("enabled");
  });

  it("human output does not print the ingest URL", async () => {
    const { stdout, exitCode } = await runCli(["telemetry", "status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Telemetry");
    expect(stdout).toContain("enabled");
    expect(stdout).not.toMatch(/endpoint/i);
    expect(stdout).not.toContain("apibeehive");
    expect(stdout).not.toContain("event-ingestion");
    expect(stdout).toContain("TELEMETRY.md");
  });

  it("names the env var that disabled telemetry ", async () => {
    process.env.DO_NOT_TRACK = "1";
    const { stdout, exitCode } = await runCli(["telemetry", "status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("disabled");
    expect(stdout).toContain("DO_NOT_TRACK");
  });

  it("names CHARGEBEE_CLI_TELEMETRY when that env var disabled it", async () => {
    process.env.CHARGEBEE_CLI_TELEMETRY = "0";
    const { stdout, exitCode } = await runCli(["telemetry", "status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("disabled");
    expect(stdout).toContain("CHARGEBEE_CLI_TELEMETRY");
  });

  it("names CI when running in CI", async () => {
    process.env.CI = "1";
    const { stdout, exitCode } = await runCli(["telemetry", "status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("disabled");
    expect(stdout).toContain("CI environment detected");
  });

  it("shows a plural pending count", async () => {
    for (let i = 0; i < 2; i++) {
      appendRecord({
        env: "production",
        site_name: "acme-test",
        visitor_id: "vid",
        cli_version: "1.0.0",
        event: { name: `customer list ${i}`, timestamp: new Date().toISOString(), metadata: {} },
      });
    }
    const { stdout, exitCode } = await runCli(["telemetry", "status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("2 events");
  });

  const notRoot = typeof process.getuid === "function" && process.getuid() !== 0;

  it.skipIf(process.platform === "win32" || !notRoot)(
    "names an unwritable config dir",
    async () => {
      chmodSync(configDir!, 0o500);
      try {
        const { stdout, exitCode } = await runCli(["telemetry", "status"]);
        expect(exitCode).toBe(0);
        expect(stdout).toContain("disabled");
        expect(stdout).toContain("not writable");
      } finally {
        chmodSync(configDir!, 0o700);
      }
    },
  );

  it("shows pending events and the next flush attempt time", async () => {
    appendRecord({
      env: "production",
      site_name: "acme-test",
      visitor_id: "vid",
      cli_version: "1.0.0",
      event: { name: "customer list", timestamp: new Date().toISOString(), metadata: {} },
    });
    writeState({ consecutive_flush_failures: 1, next_flush_attempt_at: Date.now() + 60_000 });
    const { stdout, exitCode } = await runCli(["telemetry", "status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Pending");
    expect(stdout).toContain("1 event");
    expect(stdout).toContain("Next attempt");
  });

  it("status shows enabled and does not print the ingest URL", async () => {
    const { stdout, exitCode } = await runCli(["telemetry", "status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("enabled");
    expect(stdout).not.toMatch(/endpoint/i);
    expect(stdout).not.toContain("apibeehive");
  });

  it("prints the spooled-but-unsent events as the request bodies a flush would POST with --pending", async () => {
    const record = (env: string, name: string, timestamp: string) => ({
      env,
      site_name: "acme-test",
      visitor_id: "vid-1",
      cli_version: "1.0.0",
      event: { name, timestamp, metadata: { status: "ok" } },
    });
    appendRecord(record("production", "customer list", "2026-09-09T12:00:00.000Z"));
    appendRecord(record("production", "invoice list", "2026-09-09T12:00:01.000Z"));
    appendRecord(record("non-production", "customer list", "2026-09-09T12:00:02.000Z"));

    const { stdout, exitCode } = await runCli(["telemetry", "status", "--pending"]);
    expect(exitCode).toBe(0);

    // One body per (env, site, visitor, version) group, exactly as a flush batches them.
    const bodies = JSON.parse(stdout);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual({
      client: "CHARGEBEE_CLI",
      visitor_id: "vid-1",
      site_name: "acme-test",
      cli_version: "1.0.0",
      events: [
        { name: "customer list", timestamp: "2026-09-09T12:00:00.000Z", metadata: { status: "ok" } },
        { name: "invoice list", timestamp: "2026-09-09T12:00:01.000Z", metadata: { status: "ok" } },
      ],
    });
    expect(Object.keys(bodies[1])).toEqual(["client", "visitor_id", "site_name", "cli_version", "events"]);
    expect(bodies[1].events).toHaveLength(1);
    // The local grouping label is never part of the wire body.
    expect(stdout).not.toContain('"env"');
  });

  it("prints an empty array with --pending when nothing is spooled", async () => {
    const { stdout, exitCode } = await runCli(["telemetry", "status", "--pending"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });
});

describe("telemetry enable/disable", () => {
  let configDir: string | undefined;
  const prevConfigDir = process.env.CHARGEBEE_CONFIG_DIR;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "cb-telemetry-toggle-"));
    process.env.CHARGEBEE_CONFIG_DIR = configDir;
    mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    if (prevConfigDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prevConfigDir;
  });

  it("disable then status reports disabled without an endpoint", async () => {
    const disabled = await runCli(["telemetry", "disable"]);
    expect(disabled.exitCode).toBe(0);
    const { stdout } = await runCli(["telemetry", "status"]);
    expect(stdout).toContain("disabled");
    expect(stdout).not.toMatch(/endpoint/i);
  });

  it("enable restores collection after disable", async () => {
    await runCli(["telemetry", "disable"]);
    const enabled = await runCli(["telemetry", "enable"]);
    expect(enabled.stdout).toContain("Telemetry enabled");
    const { stdout } = await runCli(["telemetry", "status"]);
    expect(stdout).toContain("enabled");
  });

  const notRoot = typeof process.getuid === "function" && process.getuid() !== 0;

  it.skipIf(process.platform === "win32" || !notRoot)(
    "enable reports a write failure when the config dir is not writable",
    async () => {
      chmodSync(configDir!, 0o500);
      try {
        const { stderr } = await runCli(["telemetry", "enable"]);
        expect(stderr).toContain("Could not save the setting");
      } finally {
        chmodSync(configDir!, 0o700);
      }
    },
  );

  it.skipIf(process.platform === "win32" || !notRoot)(
    "disable reports a write failure when the config dir is not writable",
    async () => {
      chmodSync(configDir!, 0o500);
      try {
        const { stderr } = await runCli(["telemetry", "disable"]);
        expect(stderr).toContain("Could not save the setting");
      } finally {
        chmodSync(configDir!, 0o700);
      }
    },
  );
});

describe("hidden telemetry flush", () => {
  let configDir: string | undefined;
  const prevConfigDir = process.env.CHARGEBEE_CONFIG_DIR;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "cb-telemetry-flush-"));
    process.env.CHARGEBEE_CONFIG_DIR = configDir;
  });

  afterEach(() => {
    if (configDir) rmSync(configDir, { recursive: true, force: true });
    if (prevConfigDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prevConfigDir;
  });

  it("runs the hidden flush command without recording itself", async () => {
    const { exitCode } = await runCli([FLUSH_COMMAND]);
    expect(exitCode).toBe(0);
  });
});
