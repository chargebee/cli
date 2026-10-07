import { accessSync, constants as fsConstants, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { diagnostic, isJsonMode } from "../output.js";
import { ENV_FLUSH_CHILD, statePath } from "./constants.js";
import { detectIsCi } from "./metadata.js";
import { readState, tryWriteState, writeState } from "./state.js";

/** Why telemetry is disabled, for `chargebee telemetry status` to explain. */
export type DisableSource =
  | "DO_NOT_TRACK"
  | "CHARGEBEE_CLI_TELEMETRY"
  | "CI"
  | "state_dir_unwritable"
  | "state_file";

function truthyEnv(name: string): boolean {
  const v = process.env[name];
  if (v === undefined) return false;
  const t = v.trim().toLowerCase();
  return t !== "" && t !== "0" && t !== "false";
}

function envDisablesTelemetry(): boolean {
  const v = (process.env.CHARGEBEE_CLI_TELEMETRY ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off";
}

/**
 * Whether the telemetry state directory can be written to. A read-only
 * `~/.chargebee/cli` (containerized/fleet-managed HOME, Nix store, etc.) must
 * not spam the first-run banner or mint a fresh visitor id every run, so
 * telemetry is treated as disabled for the run instead.
 */
function isStateDirWritable(): boolean {
  const dir = dirname(statePath());
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    accessSync(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Determine why telemetry is disabled, checking cheap environment signals
 * before ever touching the state file: `DO_NOT_TRACK`, `CHARGEBEE_CLI_TELEMETRY`,
 * and CI detection all win over a persisted `enabled: true`. Returns undefined
 * when telemetry is enabled.
 */
export function disabledSource(): DisableSource | undefined {
  if (truthyEnv("DO_NOT_TRACK")) return "DO_NOT_TRACK";
  if (envDisablesTelemetry()) return "CHARGEBEE_CLI_TELEMETRY";
  if (detectIsCi()) return "CI";
  if (!isStateDirWritable()) return "state_dir_unwritable";
  if (readState().enabled === false) return "state_file";
  return undefined;
}

/**
 * Whether telemetry is disabled.
 *
 * Disabled when this process is the detached flush child (never record
 * telemetry about flushing itself), an opt-out env var is set, the process is
 * running in CI, the state directory can't be written to, or the user ran
 * `chargebee telemetry disable` (persisted `enabled=false`).
 */
export function isTelemetryDisabled(): boolean {
  if (process.env[ENV_FLUSH_CHILD]) return true; // never record about the flush child
  return disabledSource() !== undefined;
}

/** Persist the opt-in/opt-out toggle. Returns false if the write did not persist. */
export function setTelemetryEnabled(enabled: boolean): boolean {
  return tryWriteState({ enabled });
}

/**
 * Must match TELEMETRY.md / README.md. The data is pseudonymous, not anonymous:
 * it carries a stable install id and the site name, so say so plainly.
 */
const NOTICE = [
  "",
  "  Chargebee CLI sends usage data to Chargebee: command name, flag names, exit status, error category,",
  "  CLI version and install method, OS/arch and runtime, a random install id, and the Chargebee site name of the active profile.",
  "  Never sent: argument values, API keys, customer data or webhook payloads. This run was not recorded.",
  "  Opt out anytime: chargebee telemetry disable  |  https://github.com/chargebee/cli/blob/main/TELEMETRY.md",
  "",
].join("\n");

/**
 * Print the one-time first-run notice to stderr (so it never pollutes stdout /
 * JSON output), then mark it shown. No-op if telemetry is disabled or already shown.
 *
 * Returns true only when the notice was printed by this call: that run must not
 * record anything, so the user can opt out before the first event exists.
 */
export function maybeShowFirstRunNotice(): boolean {
  if (isTelemetryDisabled()) return false;
  if (readState().notice_shown) return false;
  try {
    if (isJsonMode()) diagnostic(NOTICE);
    else process.stderr.write(NOTICE + "\n");
  } catch {
    // ignore
  }
  writeState({ notice_shown: true, notice_shown_at: new Date().toISOString().slice(0, 10) });
  return true;
}
