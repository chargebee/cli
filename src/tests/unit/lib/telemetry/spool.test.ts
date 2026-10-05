import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LOCK_STALE_MS, MAX_SPOOL_EVENTS, STALE_PROCESSING_MS, lockPath, spoolPath } from "../../../../lib/telemetry/constants.js";
import {
  acquireLock,
  appendRecord,
  readRecords,
  recoverStaleProcessing,
  releaseLock,
  requeueRecords,
  rotateForFlush,
  spoolStats,
} from "../../../../lib/telemetry/spool.js";
import type { SpoolRecord } from "../../../../lib/telemetry/types.js";

function rec(over: Partial<SpoolRecord> & { eventName?: string; ts?: string } = {}): SpoolRecord {
  const { eventName, ts, ...rest } = over;
  return {
    env: "production",
    site_name: "acme-test",
    visitor_id: "vid",
    cli_version: "1.0.0",
    event: {
      name: eventName ?? "customer list",
      timestamp: ts ?? new Date().toISOString(),
      metadata: {},
    },
    ...rest,
  };
}

describe("telemetry spool", () => {
  const prev = process.env.CHARGEBEE_CONFIG_DIR;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-spool-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prev;
  });

  it("appends records and reports count + age", () => {
    const old = rec({ ts: new Date(Date.now() - 60_000).toISOString() });
    appendRecord(old);
    appendRecord(rec({ eventName: "customer create" }));
    const { count, oldestAgeMs } = spoolStats();
    expect(count).toBe(2);
    expect(oldestAgeMs).toBeGreaterThanOrEqual(50_000);
  });

  it("skips corrupt lines when reading", () => {
    appendRecord(rec());
    writeFileSync(spoolPath(), `${readFileSync(spoolPath(), "utf-8")}not-json\n`);
    const processing = rotateForFlush();
    expect(processing).toBeTruthy();
    expect(readRecords(processing!)).toHaveLength(1);
  });

  it("returns empty stats when the spool is missing", () => {
    expect(spoolStats()).toEqual({ count: 0, oldestAgeMs: 0 });
  });

  it("drops oldest records when the spool is full", () => {
    for (let i = 0; i < MAX_SPOOL_EVENTS; i++) {
      appendRecord(rec({ eventName: `op ${i}` }));
    }
    appendRecord(rec({ eventName: "newest" }));
    const processing = rotateForFlush();
    const names = readRecords(processing!).map((r) => r.event.name);
    expect(names).toHaveLength(MAX_SPOOL_EVENTS);
    expect(names[0]).toBe("op 1");
    expect(names.at(-1)).toBe("newest");
  });

  it("rotates the live spool and returns null when empty", () => {
    expect(rotateForFlush()).toBeNull();
    appendRecord(rec());
    const processing = rotateForFlush();
    expect(processing).toBeTruthy();
    expect(rotateForFlush()).toBeNull();
  });

  it("requeues failed records onto a fresh spool", () => {
    requeueRecords([rec({ eventName: "retry" })]);
    const processing = rotateForFlush();
    expect(readRecords(processing!)[0].event.name).toBe("retry");
  });

  it("recovers a stale .processing file back onto the live spool (#126)", () => {
    appendRecord(rec({ eventName: "orphaned" }));
    const processing = rotateForFlush();
    expect(processing).toBeTruthy();
    const stale = new Date(Date.now() - STALE_PROCESSING_MS - 1000);
    utimesSync(processing!, stale, stale);

    recoverStaleProcessing();

    expect(existsSync(processing!)).toBe(false);
    const revived = rotateForFlush();
    expect(readRecords(revived!).map((r) => r.event.name)).toEqual(["orphaned"]);
  });

  it("leaves a fresh .processing file alone (#126)", () => {
    appendRecord(rec({ eventName: "in-flight" }));
    const processing = rotateForFlush();
    expect(processing).toBeTruthy();

    recoverStaleProcessing();

    expect(existsSync(processing!)).toBe(true);
    expect(readRecords(processing!).map((r) => r.event.name)).toEqual(["in-flight"]);
  });

  it("acquireLock is exclusive and reclaimable when stale", () => {
    expect(acquireLock()).toBe(true);
    expect(acquireLock()).toBe(false);
    const stale = new Date(Date.now() - LOCK_STALE_MS - 1000);
    utimesSync(lockPath(), stale, stale);
    expect(acquireLock()).toBe(true);
    releaseLock();
    expect(acquireLock()).toBe(true);
    releaseLock();
  });
});
