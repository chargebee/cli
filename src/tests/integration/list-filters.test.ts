/**
 * Isolated CLI tests for list-filter --help and the bare-key stderr warning (#33).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEnvPatcher,
  installFakeClient,
  uninstallFakeClient,
  runCli,
  type ClientConstruction,
} from "../../lib/test-support/_helpers.js";

const SITE = "acme-test";
const KEY = "test_key_v2";

let configDir: string;
let constructions: ClientConstruction[];
const env = createEnvPatcher();

beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), "cb-list-filter-"));
  env.set("CHARGEBEE_CONFIG_DIR", configDir);
  env.set("CHARGEBEE_SITE", undefined);
  env.set("CHARGEBEE_API_KEY", undefined);
  env.set("CHARGEBEE_ENV", undefined);
  env.set("CHARGEBEE_HOST", undefined);
  constructions = [];
  installFakeClient({ constructions });
  await runCli([
    "auth", "add",
    "--profile",
    "dev",
    "--site",
    SITE,
    "--api-key",
    KEY,
  ]);
});

afterEach(() => {
  uninstallFakeClient();
  env.restore();
  rmSync(configDir, { recursive: true, force: true });
});

describe("list filter help and warnings", () => {
  it("customer list --help documents operator suffixes and the list-ops URL", async () => {
    const { stdout, exitCode } = await runCli(["customer", "list", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("id[is]=");
    expect(stdout).toContain("[starts_with]");
    expect(stdout).toContain("https://apidocs.chargebee.com/docs/api/list-ops");
    expect(stdout).toContain("chargebee docs customer list");
  });

  it("customer create --help does not include the list-filter block", async () => {
    const { stdout, exitCode } = await runCli(["customer", "create", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain(
      "https://apidocs.chargebee.com/docs/api/list-ops",
    );
    expect(stdout).toContain("Request parameters in key=value format");
  });

  it("warns on stderr for a bare list filter and still calls the API", async () => {
    const { stderr, exitCode } = await runCli([
      "customer",
      "list",
      "-d",
      "id=cbdemo_alex",
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("id[is]=cbdemo_alex");
    expect(stderr).toContain("chargebee docs customer list");
  });

  it("does not warn for pagination or operator-suffixed filters", async () => {
    const { stderr, exitCode } = await runCli([
      "customer",
      "list",
      "-d",
      "limit=5",
      "-d",
      "id[is]=cbdemo_alex",
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("has no filter operator");
  });

  it("does not warn on create (bare keys are real body fields)", async () => {
    const { stderr, exitCode } = await runCli([
      "customer",
      "create",
      "-d",
      "email=a@b.c",
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("has no filter operator");
  });

  it("does not warn in code-sample mode (no API call is made)", async () => {
    const { stderr, exitCode } = await runCli([
      "customer",
      "list",
      "-s",
      "curl",
      "-d",
      "id=cbdemo_alex",
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("has no filter operator");
  });
});
