import { describe, expect, it } from "bun:test";
import { spawnCli } from "../../lib/test-support/_spawn.js";

describe("JSON output through the CLI entry point", () => {
  it.each([
    ["--json", "resources"], ["auth", "--json"], ["login", "--json"], ["auth", "status", "--json"],
    ["--json", "--version"], ["--help", "--json"], ["customer", "list", "--help", "--json"],
    ["customer", "create", "--code-sample", "curl", "--json"],
  ])("emits one JSON result: %j", async (...args) => {
    const result = await spawnCli(args as string[]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stdout.split("\n")).toHaveLength(1);
  });

  it.each([
    { args: ["bad-command"], code: 1 },
    { args: ["customer", "list", "--bad-flag"], code: 1 },
    { args: ["customer", "retrieve"], code: 1 },
    { args: ["customer", "list"], code: 3 },
    { args: ["feedback"], code: 1 },
    { args: ["listen"], code: 1 },
    { args: ["auth", "add"], code: 1 },
  ])("emits one error and preserves exit $code: $args", async ({ args, code }) => {
    const result = await spawnCli([...args, "--json"]);
    expect(result.exitCode).toBe(code);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toMatchObject({ exit_code: code, code: expect.any(String), message: expect.any(String) });
  });

  it("flushes large JSON errors completely before exiting", async () => {
    const result = await spawnCli(["--json", "x".repeat(16_000)]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.message).toContain("x".repeat(16_000));
  });

  it("refuses live writes with JSON without contacting the API", async () => {
    const result = await spawnCli(["customer", "create", "--json"], { extraEnv: { CHARGEBEE_SITE: "json-live-fixture", CHARGEBEE_API_KEY: "live_not_a_real_key" } });
    expect(result.exitCode).toBe(6);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.code).toBe("live_write_refused");
    expect(result.stderr).not.toContain("live_not_a_real_key");
  });
});
