/**
 * The documented exit-code map (README "Exit codes"): 3 unconfigured, 4
 * invalid credentials (401), 5 not found (404), 7 network unreachable. Write
 * gate / catalog gate (6) and `auth status` error states (3) have their
 * own coverage in profiles.test.ts and configure.interactive.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetRuntimeState, __setClientFactory } from "../../lib/api/sdk.js";
import {
  createEnvPatcher,
  installFakeClient,
  runCli,
  setStdinIsTTY,
  uninstallFakeClient,
  type ClientConstruction,
} from "../../lib/test-support/_helpers.js";

let configDir: string;
let constructions: ClientConstruction[];
let restoreStdin: (() => void) | undefined;
const env = createEnvPatcher();

async function configureTestSite(): Promise<void> {
  const { exitCode } = await runCli([
    "auth", "add",
    "--profile",
    "dev",
    "--site",
    "acme-test",
    "--api-key",
    "test_key",
  ]);
  expect(exitCode).toBe(0);
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "cb-exit-codes-"));
  env.set("CHARGEBEE_CONFIG_DIR", configDir);
  env.set("CHARGEBEE_SITE", undefined);
  env.set("CHARGEBEE_API_KEY", undefined);
  constructions = [];
  installFakeClient({ constructions });
  restoreStdin = setStdinIsTTY(false);
});

afterEach(() => {
  restoreStdin?.();
  uninstallFakeClient();
  __resetRuntimeState();
  env.restore();
  rmSync(configDir, { recursive: true, force: true });
});

describe("process exit codes", () => {
  it("exits 3 when nothing is configured", async () => {
    const { exitCode, stderr } = await runCli(["customer", "list"]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain("Not configured");
  });

  it("exits 4 on an invalid API key (401)", async () => {
    await configureTestSite();
    __setClientFactory(() => ({
      customer: {
        list: async () => {
          throw { http_status_code: 401, message: "unauthorized" };
        },
      },
    }) as never);
    const { exitCode } = await runCli(["customer", "list"]);
    expect(exitCode).toBe(4);
  });

  it("exits 5 when the resource is not found (404)", async () => {
    await configureTestSite();
    __setClientFactory(() => ({
      customer: {
        list: async () => {
          throw { http_status_code: 404, message: "not found" };
        },
      },
    }) as never);
    const { exitCode } = await runCli(["customer", "list"]);
    expect(exitCode).toBe(5);
  });

  it("exits 7 when the host is unreachable", async () => {
    await configureTestSite();
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND acme-test.chargebee.com"), { code: "ENOTFOUND" });
    __setClientFactory(() => ({
      customer: {
        list: async () => {
          throw new TypeError("fetch failed", { cause });
        },
      },
    }) as never);
    const { exitCode } = await runCli(["customer", "list"]);
    expect(exitCode).toBe(7);
  });
});
