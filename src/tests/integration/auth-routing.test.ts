import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvPatcher, installFakeClient, runCli, uninstallFakeClient, type ClientConstruction } from "../../lib/test-support/_helpers.js";
import { saveProfile } from "../../lib/config/profiles.js";

const env = createEnvPatcher();
let dir: string;
let calls: ClientConstruction[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cb-auth-routing-"));
  env.set("CHARGEBEE_CONFIG_DIR", dir);
  env.set("CHARGEBEE_SITE", "routing-test");
  env.set("CHARGEBEE_API_KEY", "test_synthetic_key");
  calls = [];
  installFakeClient({ constructions: calls });
});
afterEach(() => {
  uninstallFakeClient();
  env.restore();
  rmSync(dir, { recursive: true, force: true });
});

describe("auth routing", () => {
  it("bare auth displays help without saving environment credentials", async () => {
    const result = await runCli(["auth"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("add");
    expect(result.stdout).toContain("switch");
    expect(result.stdout).not.toContain("--api-key");
    expect(readdirSync(dir)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("bare auth supports structured help", async () => {
    const result = await runCli(["auth", "--json"]);
    expect(result.exitCode).toBe(0);
    const help = JSON.parse(result.stdout);
    expect(help.name).toBe("auth");
    expect(help.commands.map((c: { name: string }) => c.name)).toEqual(["add", "list", "switch", "remove", "rename", "status"]);
  });

  it.each([
    ["configure"], ["auth", "use"], ["auth", "login"], ["auth", "logout"],
    ["auth", "ad"], ["auth", "--site", "routing-test"],
    ["auth", "--site", "routing-test", "add"],
    ["auth", "list", "--api-key", "test_synthetic_key"],
    ["auth", "remove", "--region", "us"], ["auth", "add", "unexpected"],
    ["login", "--api-key", "test_synthetic_key"], ["login", "unexpected"],
  ].map(args => ({ args })))("rejects invalid routing without modifying credentials: %j", async ({ args }) => {
    expect((await runCli(args)).exitCode).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("login prints guidance in text and JSON without authenticating", async () => {
    const text = await runCli(["login"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("API-key authentication only");
    expect(text.stdout).toContain("chargebee auth add");
    const json = await runCli(["login", "--json"]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ supported: false, next_command: "chargebee auth add" });
    expect(readdirSync(dir)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("adds a profile whose name is a subcommand", async () => {
    expect((await runCli(["auth", "add", "--profile", "list"])).exitCode).toBe(0);
    expect((await runCli(["auth", "list"])).stdout).toContain("list");
  });

  it("switches and removes a profile whose name is a subcommand", async () => {
    await saveProfile("list", { site: "routing-test", api_key: "test_synthetic_key" });
    expect((await runCli(["auth", "switch", "list"])).exitCode).toBe(0);
    expect((await runCli(["auth", "remove", "list", "--yes"])).exitCode).toBe(0);
  });
});
