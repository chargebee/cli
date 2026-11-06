/**
 * The telemetry event for a command that changes the active site (`auth add`,
 * `auth switch`) must carry the site that is active after it succeeds, not the
 * one that was active before it ran.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spoolPath } from "../../lib/telemetry/constants.js";
import {
  __finalizeForTest,
  __resetTelemetryRecorderForTest,
  __setSpawnForTest,
  installTelemetry,
} from "../../lib/telemetry/index.js";
import { writeState } from "../../lib/telemetry/state.js";
import type { SpoolRecord } from "../../lib/telemetry/types.js";
import {
  clearCiEnv,
  createEnvPatcher,
  installFakeClient,
  runCli,
  setStdinIsTTY,
  uninstallFakeClient,
  type ClientConstruction,
} from "../../lib/test-support/_helpers.js";

const env = createEnvPatcher();
let configDir: string;
let restoreCiEnv: () => void = () => undefined;
let restoreStdin: (() => void) | undefined;

beforeEach(() => {
  restoreCiEnv = clearCiEnv();
  configDir = mkdtempSync(join(tmpdir(), "cb-telemetry-site-"));
  env.set("CHARGEBEE_CONFIG_DIR", configDir);
  env.set("CHARGEBEE_SITE", undefined);
  env.set("CHARGEBEE_API_KEY", undefined);
  env.set("DO_NOT_TRACK", undefined);
  env.set("CHARGEBEE_CLI_TELEMETRY", undefined);
  // A later run: the first-run notice has been shown, so events are recorded.
  writeState({ notice_shown: true });
  const constructions: ClientConstruction[] = [];
  installFakeClient({ constructions });
  restoreStdin = setStdinIsTTY(false);
  __resetTelemetryRecorderForTest();
  __setSpawnForTest(() => ({ unref() {} }));
});

afterEach(() => {
  __resetTelemetryRecorderForTest();
  __setSpawnForTest(null);
  restoreStdin?.();
  uninstallFakeClient();
  env.restore();
  restoreCiEnv();
  rmSync(configDir, { recursive: true, force: true });
});

/** Run one command with the recorder installed and return its spooled event. */
async function runRecorded(args: string[]): Promise<{ exitCode: number; record: SpoolRecord }> {
  const { exitCode } = await runCli(args, {
    configure: (program) => installTelemetry(program, "0.0.0-test"),
  });
  __finalizeForTest(exitCode);
  __resetTelemetryRecorderForTest();
  const lines = readFileSync(spoolPath(), "utf-8").trim().split("\n");
  return { exitCode, record: JSON.parse(lines.at(-1)!) as SpoolRecord };
}

/** Save a profile without recording an event. */
async function addProfile(profile: string, site: string, apiKey: string): Promise<void> {
  const { exitCode } = await runCli(["auth", "add", "--profile", profile, "--site", site, "--api-key", apiKey]);
  expect(exitCode).toBe(0);
}

describe("telemetry site label for commands that change the active site", () => {
  it("labels the first auth add with the added site, not unconfigured", async () => {
    const { exitCode, record } = await runRecorded([
      "auth", "add", "--profile", "dev", "--site", "acme-test", "--api-key", "test_key",
    ]);
    expect(exitCode).toBe(0);
    expect(record.event.name).toBe("auth add");
    expect(record.site_name).toBe("acme-test");
  });

  it("labels auth add with the new site when another profile was active", async () => {
    await addProfile("dev", "acme-test", "test_key");
    const { record } = await runRecorded([
      "auth", "add", "--profile", "other", "--site", "globex-test", "--api-key", "test_key_2",
    ]);
    expect(record.site_name).toBe("globex-test");
  });

  it("labels auth switch with the site switched to", async () => {
    await addProfile("dev", "acme-test", "test_key");
    await addProfile("other", "globex-test", "test_key_2");
    const { exitCode, record } = await runRecorded(["auth", "switch", "dev"]);
    expect(exitCode).toBe(0);
    expect(record.event.name).toBe("auth switch");
    expect(record.site_name).toBe("acme-test");
  });

  it("keeps the previous site when auth add fails", async () => {
    await addProfile("dev", "acme-test", "test_key");
    const { exitCode, record } = await runRecorded([
      "auth", "add", "--profile", "bad", "--site", "not a site!", "--api-key", "test_key_2",
    ]);
    expect(exitCode).toBe(1);
    expect(record.site_name).toBe("acme-test");
  });

  it("labels the next command from the active profile as before", async () => {
    await addProfile("dev", "acme-test", "test_key");
    const { record } = await runRecorded(["customer", "list"]);
    expect(record.site_name).toBe("acme-test");
  });

  it("records nothing when telemetry is disabled", async () => {
    env.set("CHARGEBEE_CLI_TELEMETRY", "0");
    const { exitCode } = await runCli(["auth", "add", "--profile", "dev", "--site", "acme-test", "--api-key", "test_key"], {
      configure: (program) => installTelemetry(program, "0.0.0-test"),
    });
    __finalizeForTest(exitCode);
    expect(exitCode).toBe(0);
    expect(existsSync(spoolPath())).toBe(false);
  });
});
