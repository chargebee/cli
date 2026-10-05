import { BATCH_SIZE, CLIENT_SOURCE } from "./constants.js";
import { postBatch } from "./client.js";
import { TELEMETRY_URL } from "./endpoint.js";
import {
  acquireLock,
  readRecords,
  recoverStaleProcessing,
  releaseLock,
  removeFile,
  requeueRecords,
  rotateForFlush,
} from "./spool.js";
import { recordFlushFailure, recordFlushSuccess } from "./state.js";
import type { CliAnalyticsCreateRequest, SpoolRecord } from "./types.js";

function groupKey(r: SpoolRecord): string {
  return [r.env, r.site_name, r.visitor_id, r.cli_version].join("\u0000");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** One request a flush will make, plus the spool records it carries (for requeueing on failure). */
export interface FlushBatch {
  body: CliAnalyticsCreateRequest;
  records: SpoolRecord[];
}

/**
 * Turn spool records into the exact request bodies a flush POSTs: one group per
 * (env, site, visitor, version) so a single request never mixes sites, envs or
 * identities, each group split into chunks of BATCH_SIZE.
 */
export function buildBatches(records: SpoolRecord[]): FlushBatch[] {
  const groups = new Map<string, SpoolRecord[]>();
  for (const r of records) {
    const k = groupKey(r);
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }

  const batches: FlushBatch[] = [];
  for (const list of groups.values()) {
    for (const batch of chunk(list, BATCH_SIZE)) {
      const head = batch[0];
      batches.push({
        body: {
          client: CLIENT_SOURCE,
          visitor_id: head.visitor_id,
          site_name: head.site_name,
          cli_version: head.cli_version,
          events: batch.map((r) => r.event),
        },
        records: batch,
      });
    }
  }
  return batches;
}

/**
 * Drain the spool: rotate it, group records, POST batches of BATCH_SIZE, and
 * requeue any that failed for a later run. Best-effort and silent — telemetry
 * must never surface errors. Intended to run in the detached flush child.
 *
 * Stops sending as soon as one batch fails — an unreachable endpoint must not
 * turn one flush into dozens of doomed requests — and requeues everything from
 * that point on, including batches never attempted. Backoff state is updated
 * so `spawnFlush` skips the next runs; a fully successful flush clears it.
 */
export async function runFlush(): Promise<void> {
  if (!acquireLock()) return; // another flush is in progress

  try {
    recoverStaleProcessing();

    const processing = rotateForFlush();
    if (!processing) return;

    const records = readRecords(processing);
    if (records.length === 0) {
      removeFile(processing);
      return;
    }

    const failed: SpoolRecord[] = [];
    let stopped = false;

    for (const { body, records: batch } of buildBatches(records)) {
      if (stopped) {
        failed.push(...batch);
        continue;
      }
      const ok = await postBatch(TELEMETRY_URL, body);
      if (!ok) {
        failed.push(...batch);
        stopped = true; // transport is down for this run — don't hammer it further
      }
    }

    if (stopped) recordFlushFailure();
    else recordFlushSuccess();

    if (failed.length > 0) requeueRecords(failed);
    removeFile(processing);
  } finally {
    releaseLock();
  }
}
