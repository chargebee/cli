import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { LOCK_STALE_MS, MAX_SPOOL_EVENTS, STALE_PROCESSING_MS, lockPath, spoolPath } from "./constants.js";
import type { SpoolRecord } from "./types.js";

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

function serialize(rec: SpoolRecord): string {
  return JSON.stringify(rec);
}

function parseLines(content: string): SpoolRecord[] {
  const out: SpoolRecord[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as SpoolRecord);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

/**
 * Append one record to the spool (synchronous so it can run from the process
 * `exit` handler). Enforces the spool cap by dropping the oldest records when full.
 */
export function appendRecord(rec: SpoolRecord): void {
  const p = spoolPath();
  ensureDir(p);

  if (existsSync(p)) {
    let count = 0;
    try {
      const content = readFileSync(p, "utf-8");
      count = content.split("\n").filter((l) => l.trim()).length;
    } catch {
      count = 0;
    }
    if (count >= MAX_SPOOL_EVENTS) {
      // Drop oldest to stay bounded, then append the new record.
      try {
        const kept = parseLines(readFileSync(p, "utf-8")).slice(-(MAX_SPOOL_EVENTS - 1));
        const body = kept.map(serialize).join("\n") + (kept.length ? "\n" : "");
        writeFileSync(p, body + serialize(rec) + "\n", { mode: 0o600 });
        return;
      } catch {
        // fall through to plain append
      }
    }
  }

  appendFileSync(p, serialize(rec) + "\n", { mode: 0o600 });
}

/** Current spool size and age (ms) of the oldest event, for the flush trigger. */
export function spoolStats(): { count: number; oldestAgeMs: number } {
  try {
    const records = parseLines(readFileSync(spoolPath(), "utf-8"));
    if (records.length === 0) return { count: 0, oldestAgeMs: 0 };
    const oldestTs = Date.parse(records[0].event.timestamp);
    const oldestAgeMs = Number.isFinite(oldestTs) ? Date.now() - oldestTs : 0;
    return { count: records.length, oldestAgeMs };
  } catch {
    return { count: 0, oldestAgeMs: 0 };
  }
}

/**
 * Atomically rotate the spool out of the way for processing: rename the live
 * spool to a private file so concurrent appends start a fresh spool. Returns the
 * rotated path, or null when there's nothing to flush.
 */
export function rotateForFlush(): string | null {
  const p = spoolPath();
  if (!existsSync(p)) return null;
  const processing = `${p}.${process.pid}.${Date.now()}.processing`;
  try {
    renameSync(p, processing);
    return processing;
  } catch {
    return null;
  }
}

export function readRecords(path: string): SpoolRecord[] {
  try {
    return parseLines(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

/** Append records back onto the live spool (used to requeue failed batches). */
export function requeueRecords(records: SpoolRecord[]): void {
  if (records.length === 0) return;
  const p = spoolPath();
  ensureDir(p);
  try {
    appendFileSync(p, records.map(serialize).join("\n") + "\n", { mode: 0o600 });
  } catch {
    // best-effort
  }
}

export function removeFile(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // ignore
  }
}

/**
 * Try to acquire the flush lock. Uses exclusive file creation; a lock older than
 * LOCK_STALE_MS is reclaimed (previous flush likely crashed). Returns true on success.
 */
export function acquireLock(): boolean {
  const p = lockPath();
  ensureDir(p);
  try {
    const fd = openSync(p, "wx");
    closeSync(fd);
    return true;
  } catch {
    // Exists — reclaim if stale.
    try {
      const age = Date.now() - statSync(p).mtimeMs;
      if (age > LOCK_STALE_MS) {
        const fd = openSync(p, "w");
        closeSync(fd);
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }
}

export function releaseLock(): void {
  removeFile(lockPath());
}

/**
 * Merge back any `telemetry-spool.ndjson.<pid>.<ts>.processing` file older than
 * {@link STALE_PROCESSING_MS} onto the live spool, so a flush child that crashed
 * mid-run (SIGKILL, sleep, shutdown) doesn't orphan its events forever. A
 * `.processing` file within the window is left alone — it may belong to a
 * flush that is still actively sending it.
 */
export function recoverStaleProcessing(): void {
  const p = spoolPath();
  const dir = dirname(p);
  const prefix = `${basename(p)}.`;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.startsWith(prefix) || !file.endsWith(".processing")) continue;
    const full = join(dir, file);
    try {
      const age = Date.now() - statSync(full).mtimeMs;
      if (age < STALE_PROCESSING_MS) continue;
      const records = readRecords(full);
      if (records.length > 0) requeueRecords(records);
      removeFile(full);
    } catch {
      // best-effort — leave this file for a later attempt
    }
  }
}
