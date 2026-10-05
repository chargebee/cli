import { spawn, type ChildProcess } from "node:child_process";

import { type Command, type CommanderError } from "commander";

import {
  peekActiveSiteName,
  resolveApiHost,
  resolveCatalogVersion,
} from "../api/sdk.js";
import { exitCommand } from "../output.js";
import { PRODUCTION_HOST, telemetryEnvLabel } from "../config/host.js";
import { resolveEntryScript } from "../runtime.js";
import {
  BATCH_SIZE,
  ENV_FLUSH_CHILD,
  FLUSH_COMMAND,
  MAX_AGE_MS,
} from "./constants.js";
import { buildMetadata, normalizeGeneratedResource } from "./metadata.js";
import { recordTelemetryError, takeTelemetryError } from "./error.js";
import { wasInteractive } from "./interactive.js";
import { isTelemetryDisabled, maybeShowFirstRunNotice } from "./optout.js";
import { getVisitorId } from "./identity.js";
import { appendRecord, spoolStats } from "./spool.js";
import { readState } from "./state.js";
import { knownCommandPath } from "./command-path.js";
import type { SpoolRecord } from "./types.js";

export type ListenPhase = "established" | "closed" | "error";

/** Process start — duration is measured from here so it covers parse + action. */
const PROCESS_START = Date.now();

let _version = "0.0.0";
let finalized = false;
/** True once `listen` has spooled a lifecycle event; skip the generic exit event. */
let listenLifecycleEmitted = false;
let exitHandler: ((code: number) => void) | null = null;

/** TEST-ONLY: replace `spawn` so flush-child tests never start a process. */
type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { detached?: boolean; stdio?: string; windowsHide?: boolean; env?: NodeJS.ProcessEnv },
) => Pick<ChildProcess, "unref">;
let spawnImpl: SpawnFn = spawn as unknown as SpawnFn;

/** TEST-ONLY: inject a fake `spawn`. Pass null to restore. */
export function __setSpawnForTest(fn: SpawnFn | null): void {
  spawnImpl = fn ?? (spawn as unknown as SpawnFn);
}

/** TEST-ONLY: reset recorder module state between tests. */
export function __resetTelemetryRecorderForTest(): void {
  pending = null;
  finalized = false;
  listenLifecycleEmitted = false;
  _version = "0.0.0";
  if (exitHandler) {
    process.removeListener("exit", exitHandler);
    exitHandler = null;
  }
}

function onProcessExit(code: number): void {
  finalize(code);
}

/** `.catch` fallback when site/catalog lookup rejects during `begin()`. */
export function ignoreFailedAuthLookup(): undefined {
  return undefined;
}

/** `.catch` fallback when host lookup rejects during `begin()`. */
export function productionHostFallback() {
  return PRODUCTION_HOST;
}

/** TEST-ONLY: run finalize without waiting for process exit. */
export function __finalizeForTest(exitCode: number): void {
  onProcessExit(exitCode);
}

interface PendingInvocation {
  command: string;
  flagNames: string[];
  generatedResource?: string;
  visitorId: string;
  siteName: string;
  pcv?: string;
  env: string;
}

let pending: PendingInvocation | null = null;

function ensurePendingForUsage(program: Command): void {
  if (pending || isTelemetryDisabled()) return;
  // Parse failures skip preAction, so the notice may not have been printed yet.
  // Nothing is recorded until the user has seen the notice at least once.
  if (!readState().notice_shown) return;
  const command = knownCommandPath(program, process.argv.slice(2));
  if (command === FLUSH_COMMAND) return;
  pending = {
    command: command || "unknown",
    flagNames: [],
    visitorId: getVisitorId(),
    siteName: "unconfigured",
    env: "production",
  };
}

/** Build the dotted command path (e.g. "addon create"), excluding the root program. */
function commandPath(cmd: Command): string {
  const names: string[] = [];
  let c: Command | null = cmd;
  while (c && c.parent) {
    names.unshift(c.name());
    c = c.parent;
  }
  return names.join(" ");
}

/**
 * Extract the *names* of flags explicitly passed on the command line (never values).
 *
 * Walks the leaf command AND its ancestors up to the root program, so global options
 * (e.g. `--use-profile`, declared on the root in
 * `index.ts`) are captured alongside the leaf command's own options. Names are deduped.
 */
function extractFlagNames(cmd: Command): string[] {
  const names = new Set<string>();
  let c: Command | null = cmd;
  while (c) {
    const anyCmd = c as unknown as {
      options?: Array<{ attributeName: () => string; long?: string; name: () => string }>;
      getOptionValueSource?: (key: string) => string | undefined;
      parent?: Command | null;
    };
    if (anyCmd.options && typeof anyCmd.getOptionValueSource === "function") {
      for (const opt of anyCmd.options) {
        try {
          if (anyCmd.getOptionValueSource(opt.attributeName()) === "cli") {
            names.add(opt.long ? opt.long.replace(/^--/, "") : opt.name());
          }
        } catch {
          // ignore individual option
        }
      }
    }
    c = (anyCmd.parent as Command | null) ?? null;
  }
  return [...names];
}

/** Record context for the invoked command (called from the preAction hook). */
async function begin(actionCommand: Command): Promise<void> {
  try {
    if (isTelemetryDisabled()) return;

    const command = commandPath(actionCommand);
    if (!command || command === FLUSH_COMMAND) return;

    // First run: print the notice and record nothing, so the user can opt out
    // before any event exists. Recording starts with the next command.
    if (maybeShowFirstRunNotice()) return;

    const flagNames = extractFlagNames(actionCommand);
    const opts = actionCommand.opts() as { codeSample?: string };
    const generatedResource = normalizeGeneratedResource(opts.codeSample);

    const visitorId = getVisitorId();
    const [siteName, pcv, host] = await Promise.all([
      peekActiveSiteName().catch(ignoreFailedAuthLookup),
      resolveCatalogVersion().catch(ignoreFailedAuthLookup),
      resolveApiHost().catch(productionHostFallback),
    ]);

    pending = {
      command,
      flagNames,
      generatedResource,
      visitorId,
      siteName: siteName || "unconfigured",
      pcv,
      env: telemetryEnvLabel(host),
    };
  } catch {
    // telemetry must never break a command
  }
}

/**
 * Mid-session `listen` event (Ready, unexpected disconnect, Ctrl+C).
 * Flushes immediately so establishment is not stuck until the process exits.
 */
export function emitListenPhase(phase: ListenPhase, errorType?: string): void {
  try {
    if (!pending || isTelemetryDisabled()) return;
    listenLifecycleEmitted = true;

    const status: "ok" | "error" = phase === "error" ? "error" : "ok";
    const metadata = buildMetadata({
      flagNames: pending.flagNames,
      durationMs: undefined,
      status,
      errorType:
        phase === "error" ? (errorType ?? "listen_connect_error") : undefined,
      productCatalogVersion: pending.pcv,
      listenPhase: phase,
    });

    appendRecord({
      env: pending.env,
      site_name: pending.siteName,
      visitor_id: pending.visitorId,
      cli_version: _version,
      event: {
        name: pending.command,
        timestamp: new Date().toISOString(),
        metadata,
      },
    });
    spawnFlush();
  } catch {
    // telemetry must never break listen
  }
}

/** Build the event from collected context + outcome, append to spool, maybe flush. */
function finalize(exitCode: number): void {
  try {
    if (!pending || finalized) return;
    finalized = true;
    if (isTelemetryDisabled()) return; // re-check: `telemetry disable` may have run
    // Lifecycle events already describe this listen run.
    if (listenLifecycleEmitted) return;

    const status: "ok" | "error" = exitCode === 0 ? "ok" : "error";
    const errorType = status === "error" ? takeTelemetryError() ?? "nonzero_exit" : undefined;
    const skipDuration = wasInteractive() || pending.command === "listen";

    const metadata = buildMetadata({
      flagNames: pending.flagNames,
      // Omit duration for interactive runs — it'd be dominated by human input time.
      // `listen` waits on webhooks; wall-clock is not work.
      durationMs: skipDuration ? undefined : Date.now() - PROCESS_START,
      status,
      errorType,
      productCatalogVersion: pending.pcv,
      generatedResource: pending.generatedResource,
    });

    const record: SpoolRecord = {
      env: pending.env,
      site_name: pending.siteName,
      visitor_id: pending.visitorId,
      cli_version: _version,
      event: { name: pending.command, timestamp: new Date().toISOString(), metadata },
    };

    appendRecord(record);

    const { count, oldestAgeMs } = spoolStats();
    if (count >= BATCH_SIZE || oldestAgeMs >= MAX_AGE_MS) spawnFlush();
  } catch {
    // swallow — never block process exit
  }
}

/**
 * Argv for the flush child. `process.execPath` is always the runtime to launch;
 * an entry script is passed only when `resolveEntryScript()` finds one (npm
 * install or dev checkout), and never for a compiled binary, whose execPath IS
 * the CLI.
 */
function flushChildArgs(): string[] {
  const script = resolveEntryScript();
  return script ? [script, FLUSH_COMMAND] : [FLUSH_COMMAND];
}

/** Spawn the detached background flush so the current command isn't delayed. */
function spawnFlush(): void {
  try {
    const { next_flush_attempt_at } = readState();
    if (next_flush_attempt_at && Date.now() < next_flush_attempt_at) return; // backing off

    const child = spawnImpl(process.execPath, flushChildArgs(), {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, [ENV_FLUSH_CHILD]: "1" },
    });
    child.unref();
  } catch {
    // ignore — events stay spooled for the next run
  }
}

/**
 * Install telemetry on the program: capture each command in a preAction hook and
 * emit the event on process exit (which reliably fires even when commands call
 * `process.exit` directly, e.g. via the SDK error handler or safety gates).
 */
export function installTelemetry(program: Command, version: string): void {
  _version = version;
  if (process.env[ENV_FLUSH_CHILD]) return; // the flush child records nothing

  program.hook("preAction", async (_thisCommand, actionCommand) => {
    await begin(actionCommand as Command);
  });

  // Commander prints the usage error, then calls this instead of process.exit.
  // Parse-time failures (unknown command, missing required arg) skip preAction,
  // so seed a pending event from registered command names only.
  program.exitOverride((err: CommanderError) => {
    try {
      if (err.exitCode !== 0) {
        recordTelemetryError("usage");
        ensurePendingForUsage(program);
      }
    } catch {
      // telemetry must never break commander
    }
    exitCommand(err.exitCode, err.code);
  });

  if (exitHandler) process.removeListener("exit", exitHandler);
  exitHandler = onProcessExit;
  process.on("exit", exitHandler);
}
