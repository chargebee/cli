/**
 * Isolated CLI tests: the live-site write confirmation as emitted into the
 * generated commands. A live site refuses unconfirmed mutating operations before
 * any SDK client is constructed, runs them once confirmed at the prompt or with
 * --yes, still runs reads, and still runs the non-GET operations that only
 * compute or generate URLs (estimates, exports). A test site runs writes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetPromptsForTest, __setPromptsForTest } from "../../lib/prompts.js";
import {
  clearCiEnv,
  createEnvPatcher,
  installFakeClient,
  uninstallFakeClient,
  runCli,
  setStdinIsTTY,
  setStdoutIsTTY,
  type ClientConstruction,
} from "../../lib/test-support/_helpers.js";

const REFUSAL = "Refusing to run a write operation on live site";
const NOTICE = 'Writing to live site "acme"';

let configDir: string;
let constructions: ClientConstruction[];
let restoreTTY: Array<() => void>;
let prompts: string[];
const env = createEnvPatcher();

function useSite(site: string, apiKey: string): void {
  env.set("CHARGEBEE_SITE", site);
  env.set("CHARGEBEE_API_KEY", apiKey);
}

function useTerminal(answer: unknown): void {
  restoreTTY.push(setStdinIsTTY(true), setStdoutIsTTY(true), clearCiEnv());
  const cancelled = Symbol("cancel");
  __setPromptsForTest({
    confirm: async ({ message }: { message: string }) => {
      prompts.push(message);
      return answer === "cancel" ? cancelled : answer;
    },
    isCancel: (v) => v === cancelled,
  });
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "cb-live-gate-"));
  env.set("CHARGEBEE_CONFIG_DIR", configDir);
  env.set("CHARGEBEE_ENV", undefined);
  env.set("CHARGEBEE_HOST", undefined);
  constructions = [];
  prompts = [];
  restoreTTY = [setStdinIsTTY(false), setStdoutIsTTY(false)];
  installFakeClient({ constructions });
});

afterEach(() => {
  uninstallFakeClient();
  __resetPromptsForTest();
  // env.set() snapshots CI after clearCiEnv() removed it; undo env first so
  // clearCiEnv()'s restore puts the original CI value back last.
  env.restore();
  for (const restore of restoreTTY.reverse()) restore();
  rmSync(configDir, { recursive: true, force: true });
});

describe("live site without a terminal", () => {
  beforeEach(() => useSite("acme", "live_key"));

  it("refuses an unconfirmed write before constructing a client", async () => {
    const result = await runCli(["customer", "create", "-d", "first_name=Ada"]);
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain(REFUSAL);
    expect(result.stderr).toContain("--yes");
    expect(constructions).toHaveLength(0);
  });

  it("refuses a state-writing operation on an otherwise read-only resource", async () => {
    const result = await runCli(["hosted-page", "acknowledge", "hp_1"]);
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain(REFUSAL);
    expect(constructions).toHaveLength(0);
  });

  it("runs a write confirmed with --yes", async () => {
    const result = await runCli(["customer", "create", "-d", "first_name=Ada", "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cus_new_acme");
    expect(result.stderr).toContain(NOTICE);
  });

  it("accepts -y as the short form of --yes", async () => {
    const result = await runCli(["customer", "create", "-y", "-d", "first_name=Ada"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cus_new_acme");
  });

  it("refuses an unconfirmed write in --json mode with a structured error", async () => {
    const result = await runCli(["--json", "customer", "create", "-d", "first_name=Ada"]);
    expect(result.exitCode).toBe(6);
    expect(JSON.parse(result.stderr).error.code).toBe("live_write_refused");
    expect(constructions).toHaveLength(0);
  });

  it("runs a write confirmed with --yes in --json mode", async () => {
    const result = await runCli(["--json", "customer", "create", "-d", "first_name=Ada", "--yes"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cus_new_acme");
  });

  it("runs a GET read", async () => {
    const result = await runCli(["customer", "retrieve", "cus_1"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cus_acme");
  });

  it("runs a POST estimate", async () => {
    const result = await runCli([
      "estimate",
      "create-sub-item-estimate",
      "-d",
      "subscription_items[item_price_id][0]=basic",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain(REFUSAL);
    expect(result.stdout).toContain("est_acme");
  });

  it("runs a POST PDF download-URL retrieval", async () => {
    const result = await runCli(["invoice", "pdf", "inv_1"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain(REFUSAL);
    expect(result.stdout).toContain("acme.pdf");
  });

  it("runs a POST export", async () => {
    const result = await runCli(["export", "customers"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain(REFUSAL);
    expect(result.stdout).toContain("exp_acme");
  });
});

describe("live site in a terminal", () => {
  beforeEach(() => useSite("acme", "live_key"));

  it("runs the write after the user confirms", async () => {
    useTerminal(true);
    const result = await runCli(["customer", "create", "-d", "first_name=Ada"]);
    expect(prompts).toEqual(['Run "customer create" on LIVE site "acme"? This changes production data.']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cus_new_acme");
    expect(result.stderr).toContain(NOTICE);
  });

  it("refuses the write when the user declines", async () => {
    useTerminal(false);
    const result = await runCli(["customer", "update", "cus_1", "-d", "first_name=Ada"]);
    expect(prompts).toHaveLength(1);
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain('Nothing was changed on live site "acme"');
    expect(constructions).toHaveLength(0);
  });

  it("refuses the write when the prompt is cancelled", async () => {
    useTerminal("cancel");
    const result = await runCli(["customer", "delete", "cus_1"]);
    expect(result.exitCode).toBe(6);
    expect(constructions).toHaveLength(0);
  });

  it("skips the prompt with --yes", async () => {
    useTerminal(false);
    const result = await runCli(["customer", "create", "-d", "first_name=Ada", "--yes"]);
    expect(prompts).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  it("refuses instead of prompting when a CI runner allocates a terminal", async () => {
    useTerminal(true);
    env.set("CI", "true");
    const result = await runCli(["customer", "create", "-d", "first_name=Ada"]);
    expect(prompts).toHaveLength(0);
    expect(result.exitCode).toBe(6);
    expect(result.stderr).toContain(REFUSAL);
    expect(constructions).toHaveLength(0);
  });

  it("runs a write confirmed with --yes on a CI runner with a terminal", async () => {
    useTerminal(false);
    env.set("CI", "true");
    const result = await runCli(["customer", "create", "-d", "first_name=Ada", "--yes"]);
    expect(prompts).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });

  it("does not prompt for reads", async () => {
    useTerminal(false);
    const result = await runCli(["customer", "retrieve", "cus_1"]);
    expect(prompts).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });
});

describe("test site", () => {
  beforeEach(() => useSite("acme-test", "live_key"));

  it("runs a plain write", async () => {
    const result = await runCli(["customer", "create", "-d", "first_name=Ada"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cus_new_acme-test");
    expect(result.stderr).not.toContain("Writing to live site");
  });

  it("never prompts in a terminal", async () => {
    useTerminal(false);
    const result = await runCli(["customer", "create", "-d", "first_name=Ada"]);
    expect(prompts).toHaveLength(0);
    expect(result.exitCode).toBe(0);
  });
});
