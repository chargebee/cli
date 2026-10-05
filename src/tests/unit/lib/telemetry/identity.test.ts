import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getVisitorId } from "../../../../lib/telemetry/identity.js";
import { readState } from "../../../../lib/telemetry/state.js";

describe("getVisitorId", () => {
  const prev = process.env.CHARGEBEE_CONFIG_DIR;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-ident-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prev;
  });

  it("creates and persists an anonymous id on first use", () => {
    const first = getVisitorId();
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(readState().anonymous_id).toBe(first);
    expect(getVisitorId()).toBe(first);
  });
});
