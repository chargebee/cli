import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./constants.js";

/** Flush backoff window: 1 minute doubling up to a 6 hour ceiling. */
export const MIN_FLUSH_BACKOFF_MS = 60 * 1000;
export const MAX_FLUSH_BACKOFF_MS = 6 * 60 * 60 * 1000;

/**
 * Persisted telemetry state at `~/.chargebee/cli/telemetry.json`.
 * Kept separate from the main config so the opt-out toggle, anonymous id, and
 * first-run marker can be read/written synchronously (incl. from the process
 * `exit` handler) without touching the config parser.
 */
export interface TelemetryState {
  /** Anonymous, CLI-generated id sent as `visitor_id`. No PII, no cookies. */
  anonymous_id: string;
  /** Opt-out toggle; defaults to enabled (telemetry is on unless disabled). */
  enabled: boolean;
  /** Whether the one-time first-run notice has been shown. */
  notice_shown: boolean;
  /** Consecutive flush runs that ended with at least one failed batch. */
  consecutive_flush_failures: number;
  /** Epoch ms before which `spawnFlush` skips spawning a new flush child. */
  next_flush_attempt_at: number;
}

const DEFAULT_STATE: TelemetryState = {
  anonymous_id: "",
  enabled: true,
  notice_shown: false,
  consecutive_flush_failures: 0,
  next_flush_attempt_at: 0,
};

/** Read telemetry state, returning defaults when missing or unreadable/corrupt. */
export function readState(): TelemetryState {
  try {
    const raw = readFileSync(statePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<TelemetryState>;
    return {
      anonymous_id:
        typeof parsed.anonymous_id === "string" ? parsed.anonymous_id : "",
      enabled: parsed.enabled !== false,
      notice_shown: parsed.notice_shown === true,
      consecutive_flush_failures:
        typeof parsed.consecutive_flush_failures === "number" ? parsed.consecutive_flush_failures : 0,
      next_flush_attempt_at:
        typeof parsed.next_flush_attempt_at === "number" ? parsed.next_flush_attempt_at : 0,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function persist(next: TelemetryState): boolean {
  try {
    const p = statePath();
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    writeFileSync(p, JSON.stringify(next, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Merge and persist telemetry state (best-effort; swallows write errors). */
export function writeState(patch: Partial<TelemetryState>): TelemetryState {
  const next = { ...readState(), ...patch };
  persist(next);
  return next;
}

/**
 * Like {@link writeState} but reports whether the write actually persisted. Used by
 * the explicit `telemetry enable/disable` toggle so we never claim success on a
 * failed write.
 */
export function tryWriteState(patch: Partial<TelemetryState>): boolean {
  return persist({ ...readState(), ...patch });
}

/** Exponential backoff for the Nth consecutive flush failure: 1m, 2m, 4m, … capped at 6h. */
export function computeFlushBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(MIN_FLUSH_BACKOFF_MS * 2 ** (consecutiveFailures - 1), MAX_FLUSH_BACKOFF_MS);
}

/** A flush run ended with at least one undelivered batch: bump and persist the backoff window. */
export function recordFlushFailure(): void {
  const consecutive = readState().consecutive_flush_failures + 1;
  writeState({
    consecutive_flush_failures: consecutive,
    next_flush_attempt_at: Date.now() + computeFlushBackoffMs(consecutive),
  });
}

/** A flush run delivered everything it attempted: clear the backoff window. */
export function recordFlushSuccess(): void {
  writeState({ consecutive_flush_failures: 0, next_flush_attempt_at: 0 });
}
