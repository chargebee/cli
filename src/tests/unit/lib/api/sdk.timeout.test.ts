import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetRuntimeState,
  __setClientFactory,
  detectCatalog,
  resolveTimeoutMs,
} from "../../../../lib/api/sdk.js";

interface CapturedConstruction {
  site: string;
  apiKey: string;
  hostSuffix: string;
  protocol?: string;
  timeout?: number;
}

describe("client-construction timeout", () => {
  const prevDir = process.env.CHARGEBEE_CONFIG_DIR;
  const prevTimeout = process.env.CHARGEBEE_CLI_TIMEOUT_MS;
  let dir: string;
  let captured: CapturedConstruction[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-sdk-timeout-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    __resetRuntimeState();
    captured = [];
    __setClientFactory((opts: CapturedConstruction) => {
      captured.push(opts);
      return { configuration: { list: async () => ({ configurations: [] }) } } as never;
    });
  });

  afterEach(() => {
    __setClientFactory(null);
    __resetRuntimeState();
    rmSync(dir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prevDir;
    if (prevTimeout === undefined) delete process.env.CHARGEBEE_CLI_TIMEOUT_MS;
    else process.env.CHARGEBEE_CLI_TIMEOUT_MS = prevTimeout;
  });

  it("passes the 30s default timeout to the client when unset", async () => {
    delete process.env.CHARGEBEE_CLI_TIMEOUT_MS;
    expect(resolveTimeoutMs()).toBe(30_000);
    // Only the construction made by this call matters; a client built by
    // unrelated in-flight work elsewhere in the process is not under test.
    captured.length = 0;
    await detectCatalog("acme-test", "key");
    expect(captured.at(-1)?.timeout).toBe(30_000);
  });

  it("passes CHARGEBEE_CLI_TIMEOUT_MS through to the client construction options", async () => {
    process.env.CHARGEBEE_CLI_TIMEOUT_MS = "5000";
    expect(resolveTimeoutMs()).toBe(5000);
    captured.length = 0;
    await detectCatalog("acme-test", "key");
    expect(captured.at(-1)?.timeout).toBe(5000);
  });

  it("falls back to the default for a non-numeric override", () => {
    process.env.CHARGEBEE_CLI_TIMEOUT_MS = "not-a-number";
    expect(resolveTimeoutMs()).toBe(30_000);
  });

  it("falls back to the default for a zero or negative override", () => {
    process.env.CHARGEBEE_CLI_TIMEOUT_MS = "0";
    expect(resolveTimeoutMs()).toBe(30_000);
    process.env.CHARGEBEE_CLI_TIMEOUT_MS = "-100";
    expect(resolveTimeoutMs()).toBe(30_000);
  });
});
