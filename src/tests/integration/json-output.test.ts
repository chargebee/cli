import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "../../program.js";
import { runProgram } from "../../lib/cli-errors.js";
import { __setSpawnForTest } from "../../lib/open/index.js";
import { __setInstallMethodForTest, __setSpawnSyncForTest } from "../../lib/update/index.js";
import { saveProfile } from "../../lib/config/profiles.js";
import { writeConfig } from "../../lib/config/store.js";
import { __setClientFactory } from "../../lib/api/sdk.js";
import { createEnvPatcher, installFakeClient, uninstallFakeClient, runCli, setStdinIsTTY, setStdoutIsTTY } from "../../lib/test-support/_helpers.js";
import { __setPromptsForTest, __resetPromptsForTest } from "../../lib/prompts.js";
import { __resetDocsMemoForTest } from "../../lib/docs/index.js";

const env = createEnvPatcher();
let root: string;
let restoreInput: () => void;
let restoreOutput: () => void;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cb-json-"));
  env.set("CHARGEBEE_CONFIG_DIR", join(root, "config"));
  env.set("HOME", join(root, "home"));
  env.set("CHARGEBEE_SITE", undefined);
  env.set("CHARGEBEE_API_KEY", undefined);
  env.set("CHARGEBEE_REGION", undefined);
  env.set("SHELL", "/bin/zsh");
  restoreInput = setStdinIsTTY(true);
  restoreOutput = setStdoutIsTTY(true);
  __setPromptsForTest({ spinner: () => { throw new Error("unexpected spinner"); }, select: () => { throw new Error("unexpected prompt"); } });
  installFakeClient({ constructions: [] });
  __resetDocsMemoForTest();
});
afterEach(() => {
  restoreInput(); restoreOutput();
  __resetPromptsForTest();
  uninstallFakeClient();
  __setSpawnForTest(null);
  __setSpawnSyncForTest(null);
  __setInstallMethodForTest(null);
  __resetDocsMemoForTest();
  globalThis.fetch = originalFetch;
  env.restore();
  rmSync(root, { recursive: true, force: true });
});

async function json(args: string[]) {
  const result = await runCli([...args, "--json"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).not.toContain("\x1b");
  expect(result.stdout.split("\n")).toHaveLength(1);
  if (result.stderr) expect(JSON.parse(result.stderr)).toHaveProperty("warnings");
  return JSON.parse(result.stdout);
}
async function configure(name = "dev", site = "acme-test") {
  return json(["auth", "add", "--profile", name, "--site", site, "--api-key", "test_not_a_real_key"]);
}

describe("global JSON output", () => {
  it("lets the entry point return with a failing exit code so piped output can drain", async () => {
    const savedCode = process.exitCode;
    const errors: string[] = [];
    const stderr = spyOn(console, "error").mockImplementation((value) => { errors.push(String(value)); });
    const exit = spyOn(process, "exit").mockImplementation((() => { throw new Error("premature process.exit"); }) as never);
    try {
      await runProgram(buildProgram("test"), ["--json", "unknown-command"], "user");
      expect(process.exitCode).toBe(1);
      expect(exit).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
      expect(JSON.parse(errors[0]!).error.code).toBe("commander.unknownCommand");
    } finally {
      stderr.mockRestore(); exit.mockRestore(); process.exitCode = savedCode;
    }
  });

  it("supports flags on either side of a command and restores human output", async () => {
    const prefix = await runCli(["--json", "resources"]);
    expect(JSON.parse(prefix.stdout).resources).toContain("customer");
    expect((await json(["resources"])).resources).toContain("customer");
    expect((await runCli(["resources"])).stdout).toContain("API resources");
  });

  it("returns structured help at every command depth and version", async () => {
    for (const args of [[], ["auth", "add"], ["customer"], ["customer", "list"], ["skills", "add"]]) {
      expect(await json([...args, "--help"])).toHaveProperty("options");
    }
    expect(await json(["--version"])).toEqual({ version: "0.0.0-test" });
    expect((await json([])).name).toBe("chargebee");
  });

  it.each([
    ["bogus"], ["customer", "list", "--bad-flag"], ["customer", "retrieve"],
    ["listen"], ["skills", "add", "--agent", "bad-agent"],
    ["skills", "list", "--global", "--project"], ["open", "bad-shortcut"],
    ["skills", "add"], ["feedback"], ["auth", "add"], ["alias", "bad-action"], ["update", "--channel", "bogus"],
  ])("returns a single structured error for %j", async (...args) => {
    const result = await runCli(["--json", ...args as string[]]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    const error = JSON.parse(result.stderr).error;
    expect(error.code).toBeString();
    expect(error.message).not.toBe("");
    expect(error.exit_code).toBe(result.exitCode);
    expect(result.stderr).not.toContain("\x1b");
  });

  it("does not interpret --json as a flag after -- or as an option value", async () => {
    expect((await runCli(["open", "--", "--json"])).stderr).not.toStartWith("{");
    expect((await runCli(["--use-profile", "--json", "resources"])).stderr).not.toStartWith("{");
  });

  it("returns configuration lifecycle results without credentials or prompts", async () => {
    expect(await json(["auth", "status"])).toEqual({ configured: false });
    expect(await json(["auth", "list"])).toEqual({ profiles: [] });
    expect(await configure()).toMatchObject({ configured: true, profile: "dev" });
    for (const args of [["auth", "status"], ["auth", "whoami"], ["whoami"], ["auth", "status"]]) {
      const status = await json(args);
      expect(status).toMatchObject({ configured: true, site: "acme-test", mode: "test" });
      expect(JSON.stringify(status)).not.toContain("test_not_a_real_key");
    }
    const profiles = await json(["auth", "list"]);
    expect(profiles.profiles[0]).toMatchObject({ name: "dev", active: true });
    expect(JSON.stringify(profiles)).not.toContain("test_not_a_real_key");
    await configure("second");
    expect(await json(["auth", "switch", "dev"])).toMatchObject({ active_profile: "dev" });
    expect(await json(["auth", "rename", "dev", "renamed"])).toMatchObject({ renamed: true });
    const refused = await runCli(["auth", "remove", "renamed", "--json"]);
    expect(JSON.parse(refused.stderr).error.message).toContain("--yes");
    expect(await json(["auth", "remove", "second", "--yes"])).toMatchObject({ removed: "second", active_profile: "renamed" });
    expect(await json(["auth", "remove", "renamed", "--yes"])).toEqual({ removed: "renamed", active_profile: null });
  });

  it("preserves API envelopes, pagination, and the human-mode data shape", async () => {
    env.set("CHARGEBEE_SITE", "acme-test"); env.set("CHARGEBEE_API_KEY", "test_key");
    __setClientFactory(() => ({ customer: { list: async () => ({ list: [], next_offset: '["123","456"]', headers: { authorization: "hidden" }, httpStatusCode: 200 }) } }) as never);
    const result = await json(["customer", "list"]);
    expect(result).toEqual({ list: [], next_offset: ["123", "456"] });
    expect(JSON.parse((await runCli(["customer", "list"])).stdout)).toEqual(result);
  });

  it.each([401, 404, 429, 500])("keeps the exit code and safe details for HTTP %i", async (status) => {
    env.set("CHARGEBEE_SITE", "acme-test"); env.set("CHARGEBEE_API_KEY", "test_key");
    __setClientFactory(() => ({ customer: { list: async () => { throw { http_status_code: status, message: "Request failed", api_error_code: "test_failure", headers: { authorization: "hidden" } }; } } }) as never);
    const result = await runCli(["customer", "list", "--json"]);
    expect(result.exitCode).toBe(status === 401 ? 4 : status === 404 ? 5 : 1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.details.http_status_code).toBe(status);
    expect(result.stderr).not.toContain("hidden");
  });

  it.each([
    { error: { http_status_code: 0, type: "timeout" }, code: "timeout" },
    { error: Object.assign(new Error("connection failed"), { code: "ECONNREFUSED" }), code: "network_error" },
  ])("returns structured transport failures ($code)", async ({ error, code }) => {
    env.set("CHARGEBEE_SITE", "acme-test"); env.set("CHARGEBEE_API_KEY", "test_key");
    __setClientFactory(() => ({ customer: { list: async () => { throw error; } } }) as never);
    const result = await runCli(["customer", "list", "--json"]);
    expect(result.exitCode).toBe(7);
    expect(JSON.parse(result.stderr).error.code).toBe(code);
  });

  it("returns code samples and language discovery as data", async () => {
    expect((await json(["customer", "create", "--code-sample", "list"])).languages).toContain("curl");
    expect(await json(["customer", "create", "--code-sample", "curl"])).toMatchObject({ language: "curl", code: expect.stringContaining("curl") });
  });

  it("keeps catalog gating for requests and code samples, while live samples skip the write gate", async () => {
    await saveProfile("pc1", { site: "acme-test", api_key: "test_key", product_catalog_version: "v1", chargebee_response_schema_type: "plans_addons" });
    await writeConfig({ activeProfile: "pc1" });
    for (const args of [["item", "list"], ["item", "list", "--code-sample", "curl"]]) {
      const result = await runCli([...args, "--json"]);
      expect(result.exitCode).toBe(6);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error.code).toBe("catalog_refused");
    }
    env.set("CHARGEBEE_SITE", "acme"); env.set("CHARGEBEE_API_KEY", "live_key");
    expect((await json(["customer", "create", "--code-sample", "curl"])).code).toContain("curl");
  });

  it("returns a browser launch request without claiming the page loaded", async () => {
    env.set("CHARGEBEE_SITE", "acme-test"); env.set("CHARGEBEE_API_KEY", "test_key");
    env.set("CI", undefined); env.set("DISPLAY", ":0");
    let calls = 0;
    __setSpawnForTest((() => { calls++; return { on() {}, unref() {} }; }) as never);
    expect(await json(["open"])).toMatchObject({ browser_requested: true });
    expect(calls).toBe(1);
  });

  it("captures update outcomes without inheriting npm output", async () => {
    env.set("GITHUB_TOKEN", "test_token");
    __setInstallMethodForTest("npm");
    globalThis.fetch = (async () => new Response(JSON.stringify([{ tag_name: "v0.0.0-test", prerelease: true }]), { status: 200 })) as unknown as typeof fetch;
    expect(await json(["update"])).toMatchObject({ updated: false, version: "0.0.0-test" });
    globalThis.fetch = (async () => new Response(JSON.stringify([{ tag_name: "v1.2.3-beta.1", prerelease: true }]), { status: 200 })) as unknown as typeof fetch;
    let installStdio: unknown;
    __setSpawnSyncForTest(((cmd: string, args: string[], opts: { stdio?: unknown }) => {
      if (cmd.includes("npm")) installStdio = opts.stdio;
      return { status: 0, stdout: args.includes("--version") ? "1.2.3-beta.1" : "npm progress", stderr: "", pid: 1, output: [], signal: null };
    }) as never);
    expect(await json(["update"])).toMatchObject({ updated: true, version: "1.2.3-beta.1" });
    expect(installStdio).toBe("pipe");
  });

  it("returns telemetry status and settings", async () => {
    expect(await json(["telemetry", "disable"])).toMatchObject({ enabled: false });
    expect(await json(["telemetry", "status"])).toHaveProperty("disabled_by");
    expect(await json(["telemetry"])).toHaveProperty("pending");
    expect(await json(["telemetry", "status", "--pending"])).toEqual([]);
    expect(await json(["telemetry", "enable"])).toHaveProperty("enabled");
  });

  it("returns alias mutations and empty listings", async () => {
    expect(await json(["alias", "show"])).toMatchObject({ aliases: [] });
    expect(await json(["alias", "remove"])).toMatchObject({ removed: false });
    expect(await json(["alias", "set"])).toMatchObject({ changed: true, name: "cb" });
    expect(await json(["alias", "set"])).toMatchObject({ changed: false });
    expect((await json(["alias", "show"])).aliases).toHaveLength(1);
    expect(await json(["alias", "remove"])).toMatchObject({ removed: true });
    expect(await json(["alias", "remove"])).toMatchObject({ removed: false });
  });

  it("returns skill lifecycle results and requires explicit removal confirmation", async () => {
    const target = ["--path", join(root, "app"), "--agent", "cursor"];
    expect(await json(["skills", "add", "--list"])).toEqual({ skills: ["chargebee-cli"] });
    expect(await json(["skills", "list", ...target])).toEqual({ installations: [] });
    expect((await json(["skills", "add", ...target])).installations[0].changed).toBe(true);
    expect((await json(["skills", "add", ...target])).installations[0].changed).toBe(false);
    expect((await json(["skills", "list", ...target])).installations).toHaveLength(1);
    expect((await json(["skills", "update", ...target])).updated).toHaveLength(1);
    expect((await runCli(["skills", "remove", ...target, "--json"])).exitCode).not.toBe(0);
    expect((await json(["skills", "remove", ...target, "--yes"])).removed).toHaveLength(1);
    expect(await json(["skills", "update", ...target])).toEqual({ updated: [] });
  });

  it("returns docs as structured text, operation names, and source URLs", async () => {
    globalThis.fetch = (async (url: unknown) => new Response(String(url).includes("sitemap.xml")
      ? '<urlset><loc>https://apidocs.chargebee.com/docs/api/customers/create-a-customer</loc></urlset>'
      : "# Customer\nDocumentation")) as unknown as typeof fetch;
    expect((await json(["docs"])).resources).toContain("customers");
    expect(await json(["docs", "customer"])).toMatchObject({ resource: "customer", operations: ["create-a-customer"] });
    expect(await json(["docs", "customer", "create"])).toMatchObject({ operation: "create", body: "# Customer\nDocumentation" });
  });

  it("returns dashboard URLs and feedback outcomes", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_key");
    expect(await json(["open", "--url-only"])).toMatchObject({ browser_requested: false });
    expect((await json(["open", "--list"])).shortcuts.length).toBeGreaterThan(0);
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    expect(await json(["feedback", "CLI feedback fixture"])).toEqual({ submitted: true });
  });
});
