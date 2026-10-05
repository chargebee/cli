import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  installFakeClient,
  runCli,
  uninstallFakeClient,
  type ClientConstruction,
} from "../../lib/test-support/_helpers.js";

describe("open", () => {
  const prevConfig = process.env.CHARGEBEE_CONFIG_DIR;
  let dir: string;

  let constructions: ClientConstruction[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-support-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    constructions = [];
    installFakeClient({ constructions });
  });

  afterEach(() => {
    uninstallFakeClient();
    rmSync(dir, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prevConfig;
  });

  it("open support is not a shortcut", async () => {
    const { exitCode, stderr } = await runCli(["open", "support"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown shortcut");
  });

  it("open --list does not offer support", async () => {
    const { stdout, exitCode } = await runCli(["open", "--list"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Dashboard:");
    expect(stdout).toContain("customers");
    expect(stdout).toContain("[accepts ID]");
    expect(stdout).not.toContain("Support:");
    expect(stdout).not.toContain("support.chargebee.com");
    expect(stdout).not.toContain("Docs:");
    expect(stdout).not.toContain("apidocs.chargebee.com");
  });

  it("open without a shortcut targets the dashboard home", async () => {
    await runCli(["auth", "add", "--profile", "dev", "--site", "acme-test", "--api-key", "test_key"]);
    const { stdout, exitCode } = await runCli(["open", "--url-only"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("https://acme-test.chargebee.com/");
  });

  it("open without a site fails for dashboard shortcuts", async () => {
    const { exitCode, stderr } = await runCli(["open", "customers"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No site configured");
  });

  it("support is no longer a top-level command", async () => {
    const { exitCode, stderr } = await runCli(["support"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("support");
  });
});
