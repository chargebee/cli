import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireLock, appendRecord, readRecords, releaseLock, rotateForFlush } from "../../../../lib/telemetry/spool.js";
import { TELEMETRY_URL } from "../../../../lib/telemetry/endpoint.js";
import { runFlush } from "../../../../lib/telemetry/flush.js";
import {
  computeFlushBackoffMs,
  MAX_FLUSH_BACKOFF_MS,
  MIN_FLUSH_BACKOFF_MS,
  readState,
} from "../../../../lib/telemetry/state.js";
import type { SpoolRecord } from "../../../../lib/telemetry/types.js";

function rec(over: Partial<SpoolRecord> = {}): SpoolRecord {
  return {
    env: "production",
    site_name: "acme-test",
    visitor_id: "vid",
    cli_version: "1.0.0",
    event: {
      name: "customer list",
      timestamp: new Date().toISOString(),
      metadata: {},
    },
    ...over,
  };
}

describe("runFlush", () => {
  const prev = process.env.CHARGEBEE_CONFIG_DIR;
  const originalFetch = globalThis.fetch;
  let dir: string;
  let posts: Array<{ url: string; body: unknown }> = [];
  let fail = false;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-flush-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    posts = [];
    fail = false;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response("ok", { status: fail ? 500 : 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prev;
  });

  it("no-ops when another flush holds the lock", async () => {
    appendRecord(rec());
    expect(acquireLock()).toBe(true);
    await runFlush();
    releaseLock();
    expect(posts).toHaveLength(0);
    expect(rotateForFlush()).toBeTruthy();
  });

  it("no-ops when the spool is empty", async () => {
    await runFlush();
    expect(posts).toHaveLength(0);
  });

  it("POSTs grouped batches and drops the processing file on success", async () => {
    appendRecord(rec());
    appendRecord(rec({ site_name: "other-test", visitor_id: "vid-2" }));
    await runFlush();
    expect(posts).toHaveLength(2);
    expect(posts.every((p) => p.url === TELEMETRY_URL)).toBe(true);
    const sites = posts.map((p) => (p.body as { site_name: string }).site_name).sort();
    expect(sites).toEqual(["acme-test", "other-test"]);
    expect(rotateForFlush()).toBeNull();
  });

  it("requeues failed batches", async () => {
    fail = true;
    appendRecord(rec({ event: { name: "retry-me", timestamp: new Date().toISOString(), metadata: {} } }));
    await runFlush();
    expect(posts).toHaveLength(1);
    const processing = rotateForFlush();
    expect(processing).toBeTruthy();
    expect(readRecords(processing!).map((r) => r.event.name)).toEqual(["retry-me"]);
  });

  it("stops after the first transport failure and requeues every remaining batch untried (#126)", async () => {
    fail = true;
    // Three separate groups (distinct site_name) so each is its own batch.
    for (let i = 0; i < 3; i++) {
      appendRecord(
        rec({ site_name: `site-${i}`, event: { name: `op-${i}`, timestamp: new Date().toISOString(), metadata: {} } }),
      );
    }
    await runFlush();
    // Only the first batch was ever POSTed — the rest were requeued untried.
    expect(posts).toHaveLength(1);
    const processing = rotateForFlush();
    expect(readRecords(processing!)).toHaveLength(3);
  });

  it("persists exponential backoff after a failed flush and clears it on success", async () => {
    fail = true;
    appendRecord(rec());
    await runFlush();
    const afterFailure = readState();
    expect(afterFailure.consecutive_flush_failures).toBe(1);
    expect(afterFailure.next_flush_attempt_at).toBeGreaterThan(Date.now());
    expect(afterFailure.next_flush_attempt_at - Date.now()).toBeLessThanOrEqual(MIN_FLUSH_BACKOFF_MS + 1000);

    fail = false;
    // The failed record was requeued; flushing again should succeed and reset backoff.
    await runFlush();
    const afterSuccess = readState();
    expect(afterSuccess.consecutive_flush_failures).toBe(0);
    expect(afterSuccess.next_flush_attempt_at).toBe(0);
  });
});

describe("computeFlushBackoffMs", () => {
  it("returns 0 with no failures", () => {
    expect(computeFlushBackoffMs(0)).toBe(0);
  });

  it("doubles from the 1-minute floor up to the 6-hour ceiling", () => {
    expect(computeFlushBackoffMs(1)).toBe(MIN_FLUSH_BACKOFF_MS);
    expect(computeFlushBackoffMs(2)).toBe(MIN_FLUSH_BACKOFF_MS * 2);
    expect(computeFlushBackoffMs(3)).toBe(MIN_FLUSH_BACKOFF_MS * 4);
    expect(computeFlushBackoffMs(20)).toBe(MAX_FLUSH_BACKOFF_MS);
  });
});
