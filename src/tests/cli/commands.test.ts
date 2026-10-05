import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProgram } from "../../program.js";
import { getCommandGroup } from "../../commands/help.js";
import { spawnCli, writeDisabledTelemetry } from "../../lib/test-support/_spawn.js";

const program = buildProgram("test");
const builtinScenarios: Record<string, string> = {
  "__telemetry-flush": "source telemetry delivery tests",
  auth: "live profiles and credentials", whoami: "live profiles", login: "authentication guidance",
  docs: "live documentation", listen: "live customer event forwarding",
  skills: "isolated filesystem lifecycle", resources: "local discovery",
  telemetry: "isolated preference lifecycle", alias: "help; shell mutation covered by installer/source tests",
  open: "invalid shortcut; browser launching intentionally excluded on runners",
  feedback: "help; submitting feedback intentionally excluded",
  update: "help; update mutation covered by source tests pending a release fixture",
};

it("assigns every builtin command to a scenario or explicit external-side-effect exception", () => {
  const builtins = program.commands.filter((cmd) => getCommandGroup(cmd) !== "resource").map((cmd) => cmd.name()).sort();
  expect(builtins).toEqual(Object.keys(builtinScenarios).sort());
});

describe("artifact command inventory", () => {
  for (const command of program.commands) {
    it(`${command.name()} and its public subcommands expose help`, async () => {
      const paths = [[command.name()], ...command.commands
        .filter((child) => !child.name().startsWith("__"))
        .map((child) => [command.name(), child.name()])];
      for (const args of paths) {
        const result = await spawnCli([...args, "--help"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/Usage:|USAGE/);
      }
    }, 180_000);
  }
});

it("blocks LIVE customer creation with the CLI's write-gate exit code", async () => {
  const result = await spawnCli(["customer", "create", "-d", "id=cb-gate-must-not-exist"], {
    extraEnv: { CHARGEBEE_SITE: "cb-gate-validation", CHARGEBEE_API_KEY: "live_synthetic_invalid" },
  });
  expect(result.exitCode).toBe(6);
  expect(result.stderr).toContain("Refusing to run a write operation on live site");
  expect(result.stdout).toBe("");
});

it("gates incompatible catalog commands before API calls, including code samples", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-catalog-"));
  writeDisabledTelemetry(dir);
  mkdirSync(join(dir, "profiles"));
  try {
    for (const [name, catalog, schema, resource] of [
      ["pc1", "v1", "plans_addons", "item"], ["pc2", "v2", "items", "plan"],
    ]) {
      writeFileSync(join(dir, "profiles", `${name}.json`), JSON.stringify({ site: "cb-catalog-test", api_key: "test_invalid", product_catalog_version: catalog, chargebee_response_schema_type: schema }));
      for (const suffix of [[], ["--code-sample", "curl"]]) {
        const result = await spawnCli(["--use-profile", name, resource, "list", ...suffix], { configDir: dir });
        expect(result.exitCode).toBe(6);
        expect(result.stderr).toContain("isn't available on your site");
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("installs, lists, updates and removes skills in isolated project and global locations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-skills-process-"));
  const home = join(dir, "home");
  const project = join(dir, "project");
  mkdirSync(home); mkdirSync(project);
  const opts = { extraEnv: { HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"), XDG_CONFIG_HOME: join(home, ".config") } };
  try {
    for (const scope of [["--path", project], ["--global"]]) {
      const destination = join(scope[0] === "--global" ? home : project, ".cursor", "skills", "chargebee-cli", "SKILL.md");
      expect((await spawnCli(["skills", "add", ...scope, "-a", "cursor", "-s", "chargebee-cli", "-y"], opts)).exitCode).toBe(0);
      expect(readFileSync(destination, "utf8")).toContain("chargebee");
      expect((await spawnCli(["skills", "list", ...scope], opts)).stdout).toContain("chargebee-cli");
      expect((await spawnCli(["skills", "update", ...scope, "-a", "cursor", "-y"], opts)).exitCode).toBe(0);
      expect((await spawnCli(["skills", "remove", ...scope, "-a", "cursor", "-y"], opts)).exitCode).toBe(0);
      expect(existsSync(destination)).toBe(false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("runs resource discovery and persists telemetry preferences across processes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-local-process-"));
  writeDisabledTelemetry(dir);
  try {
    expect((await spawnCli(["resources"], { configDir: dir })).stdout).toContain("customer");
    expect((await spawnCli(["telemetry", "disable"], { configDir: dir })).exitCode).toBe(0);
    expect((await spawnCli(["telemetry", "status"], { configDir: dir })).stdout).toMatch(/disabled|off/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
