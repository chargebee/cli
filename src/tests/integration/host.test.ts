/**
 * Isolated CLI tests for profile host resolution, CHARGEBEE_HOST, and open URLs.
 * Profile persist / status JSON for host lives in `profiles.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../../lib/config/store.js";

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

function lastHost(): string | undefined {
  return constructions.at(-1)?.hostSuffix;
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "cb-host-"));
  env.set("CHARGEBEE_CONFIG_DIR", configDir);
  env.set("CHARGEBEE_SITE", undefined);
  env.set("CHARGEBEE_API_KEY", undefined);
  env.set("CHARGEBEE_ENV", undefined);
  env.set("CHARGEBEE_HOST", undefined);
  constructions = [];
  installFakeClient({ constructions });
});

afterEach(() => {
  uninstallFakeClient();
  env.restore();
  rmSync(configDir, { recursive: true, force: true });
});

describe("API host resolution", () => {
  it("defaults to .chargebee.com", async () => {
    await runCli([
      "auth", "add",
      "--profile",
      "dev",
      "--site",
      SITE,
      "--api-key",
      KEY,
    ]);
    await runCli(["customer", "list"]);
    expect(lastHost()).toBe(".chargebee.com");
  });

  it("CHARGEBEE_HOST=example.com targets *.example.com when credentials come from the environment", async () => {
    env.set("CHARGEBEE_SITE", SITE);
    env.set("CHARGEBEE_API_KEY", KEY);
    env.set("CHARGEBEE_HOST", "example.com");
    const { exitCode } = await runCli(["customer", "list"]);
    expect(exitCode).toBe(0);
    expect(lastHost()).toBe(".example.com");
  });

  it("a saved profile host wins over CHARGEBEE_HOST", async () => {
    await runCli([
      "auth", "add",
      "--profile",
      "dev",
      "--site",
      SITE,
      "--api-key",
      KEY,
      "--host",
      "example.com",
    ]);
    const listed = await runCli(["auth", "list"]);
    expect(listed.stdout).toMatch(/dev\s+\S+\s+us\s+example\.com\s+/);
    env.set("CHARGEBEE_HOST", "chargebee.com");
    const { exitCode } = await runCli(["customer", "list"]);
    expect(exitCode).toBe(0);
    expect(lastHost()).toBe(".example.com");
  });

  it("configure without --host saves production even when the active profile and CHARGEBEE_HOST are not", async () => {
    await runCli([
      "auth", "add",
      "--profile",
      "dev",
      "--site",
      SITE,
      "--api-key",
      KEY,
      "--host",
      "example.com",
    ]);
    env.set("CHARGEBEE_HOST", "example.com");
    const configured = await runCli([
      "auth", "add",
      "--profile",
      "fresh",
      "--site",
      "other-test",
      "--api-key",
      KEY,
    ]);
    expect(configured.exitCode).toBe(0);
    expect(lastHost()).toBe(".chargebee.com");
    const listed = await runCli(["auth", "list"]);
    expect(listed.stdout).toMatch(/dev\s+\S+\s+us\s+example\.com\s+/);
    expect(listed.stdout).toMatch(/fresh\s+\S+\s+us\s+chargebee\.com\s+/);
  });

  it("rejects --host on an API command", async () => {
    const { stderr, exitCode } = await runCli([
      "--host",
      "example.com",
      "customer",
      "list",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown option '--host'");
  });

  it("open refuses custom profile browser URLs", async () => {
    await runCli([
      "auth", "add",
      "--profile",
      "dev",
      "--site",
      SITE,
      "--api-key",
      KEY,
      "--host",
      "example.com",
    ]);
    const { stdout, exitCode } = await runCli([
      "open",
      "customers",
      "--url-only",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stdout.trim()).toBe("");
  });

  it("open --url-only percent-encodes a hostile resource id", async () => {
    await runCli(["auth", "add", "--profile", "dev", "--site", SITE, "--api-key", KEY]);
    const hostile = 'x$(id)"; echo pwned; "';
    const { stdout, exitCode } = await runCli(["open", "customer", hostile, "--url-only"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(
      `https://${SITE}.chargebee.com/d/customers/${encodeURIComponent(hostile)}`,
    );
    expect(stdout).not.toContain("$(");
  });

  it("configure rejects an invalid --host", async () => {
    const { stderr, exitCode } = await runCli([
      "auth", "add",
      "--site",
      SITE,
      "--api-key",
      KEY,
      "--host",
      "staging",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid API host");
  });

  it("auth add rejects malformed host syntax", async () => {
    const { stderr, exitCode } = await runCli([
      "auth", "add",
      "--site",
      SITE,
      "--api-key",
      KEY,
      "--host",
      "invalid@host",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid API host");
  });

  it("auth add --help documents --host and root help does not", async () => {
    const root = await runCli(["--help"]);
    expect(root.stdout).not.toContain("--host");
    const configure = await runCli(["auth", "add", "--help"]);
    expect(configure.exitCode).toBe(0);
    expect(configure.stdout).toContain("--host <host>");
    expect(configure.stdout).toContain("chargebee.com");
  });
});


describe("malformed API hosts", () => {
  it("rejects an environment host before constructing an API client", async () => {
    env.set("CHARGEBEE_SITE", SITE);
    env.set("CHARGEBEE_API_KEY", KEY);
    env.set("CHARGEBEE_HOST", "https://invalid@host");
    const result = await runCli(["customer", "list"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid API host");
    expect(constructions).toHaveLength(0);
  });

  it("rejects an unsupported saved profile host before constructing an API client", async () => {
    mkdirSync(join(configDir, "profiles"), { recursive: true });
    writeFileSync(join(configDir, "profiles", "unsupported.json"), JSON.stringify({
      site: SITE, api_key: KEY, host: "invalid@host",
    }));
    const result = await runCli(["--use-profile", "unsupported", "customer", "list"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid API host");
    expect(constructions).toHaveLength(0);
  });
  it("rejects a malformed active-profile host without falling back to production", async () => {
    mkdirSync(join(configDir, "profiles"), { recursive: true });
    writeFileSync(join(configDir, "profiles", "unsupported.json"), JSON.stringify({
      site: SITE, api_key: KEY, host: "invalid@host",
    }));
    await writeConfig({ domain: SITE, activeProfile: "unsupported" });
    const result = await runCli(["customer", "list"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid API host");
    expect(constructions).toHaveLength(0);
  });

});
