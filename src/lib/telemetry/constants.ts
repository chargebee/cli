import { join } from "node:path";
import { configDir } from "../config/store.js";

/**
 * Telemetry tunables. A flush is triggered once this many events are spooled (or the
 * oldest event exceeds MAX_AGE_MS). The spool is capped at MAX_SPOOL_EVENTS so it
 * stays bounded across invocations; oldest events are dropped past the cap.
 */
export const BATCH_SIZE = 5;
export const MAX_SPOOL_EVENTS = 500;
/** Flush if the oldest spooled event is older than this, even below BATCH_SIZE. */
export const MAX_AGE_MS = 5 * 60 * 1000;
/** Per-request network timeout for a flush POST. */
export const HTTP_TIMEOUT_MS = 3000;
/** A flush lock older than this is treated as stale (crashed flush) and reclaimed. */
export const LOCK_STALE_MS = 60 * 1000;
/** A `.processing` file older than this is assumed orphaned by a crashed flush and recovered. */
export const STALE_PROCESSING_MS = 2 * 60 * 1000;

/**
 * Headless client discriminator sent with each telemetry event. Must match a
 * value of the server-side `CliClientSource` enum exactly (case-sensitive).
 */
export const CLIENT_SOURCE = "CHARGEBEE_CLI";

/** Set on the detached flush child so it never records telemetry about itself. */
export const ENV_FLUSH_CHILD = "CHARGEBEE_CLI_TELEMETRY_FLUSH";

/** Hidden subcommand the detached flush child runs. */
export const FLUSH_COMMAND = "__telemetry-flush";

export function spoolPath(): string {
  return join(configDir(), "telemetry-spool.ndjson");
}

export function lockPath(): string {
  return join(configDir(), "telemetry-spool.lock");
}

export function statePath(): string {
  return join(configDir(), "telemetry.json");
}
