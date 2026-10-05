import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __setPromptsForTest, __resetPromptsForTest } from "../../lib/prompts.js";
import { runCli } from "../../lib/test-support/_helpers.js";

describe("skills command", () => {
  const prevConfig = process.env.CHARGEBEE_CONFIG_DIR;
  const previousHome = process.env.HOME;
  const agentEnv = ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"] as const;
  const previousAgentEnv = Object.fromEntries(agentEnv.map((key) => [key, process.env[key]]));
  const previousStdin = process.stdin.isTTY;
  const previousStdout = process.stdout.isTTY;
  function terminal(value: boolean) {
    Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
  }
  let root: string;
  let project: string;

  beforeEach(() => {
    terminal(false);
    root = mkdtempSync(join(tmpdir(), "cb-skills-cli-"));
    project = join(root, "app");
    process.env.CHARGEBEE_CONFIG_DIR = join(root, "cfg");
    process.env.HOME = join(root, "home");
    for (const key of agentEnv) delete process.env[key];
  });

  afterEach(() => {
    __resetPromptsForTest();
    Object.defineProperty(process.stdin, "isTTY", { value: previousStdin, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: previousStdout, configurable: true });
    rmSync(root, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prevConfig;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    for (const key of agentEnv) {
      if (previousAgentEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousAgentEnv[key];
    }
  });


  it.each(["add", "update", "remove"])("%s exposes shared selection flags and rejects conflicting scopes", async (operation) => {
    const help = await runCli(["skills", operation, "--help"]);
    for (const flag of ["--project", "--global", "--skill", "--agent", "--yes"]) expect(help.stdout).toContain(flag);
    expect((await runCli(["skills", operation, "-p", "-g"])).exitCode).not.toBe(0);
    expect((await runCli(["skills", operation, "-s", "missing", "-y"])).exitCode).not.toBe(0);
  });

  it.each(["update", "remove"])("%s validates positional skill names before changing files", async (operation) => {
    await runCli(["skills", "add", "--path", project, "-a", "cursor"]);
    const path = join(project, ".cursor/skills/chargebee-cli/SKILL.md");
    writeFileSync(path, "unchanged");
    const invalid = await runCli(["skills", operation, "chargebee-cli", "missing", "--path", project, "-y"]);
    expect(invalid.exitCode).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe("unchanged");
    const valid = await runCli(["skills", operation, "chargebee-cli", "--path", project, "-y"]);
    expect(valid.exitCode).toBe(0);
    if (operation === "remove") expect(existsSync(path)).toBe(false);
    else expect(readFileSync(path, "utf8")).toContain("name: chargebee-cli");
  });

  it.each(["project", "global", "custom-global"])("agent picker shows the actual %s installation paths", async (scope) => {
    if (scope === "custom-global") {
      process.env.XDG_CONFIG_HOME = join(root, "custom-config");
      process.env.CODEX_HOME = join(root, "custom-codex");
    }
    terminal(true);
    const hints: Record<string, string> = {};
    __setPromptsForTest({
      multiselect: async (opts: { options: Array<{ value: string; hint: string }> }) => {
        for (const option of opts.options) hints[option.value] = option.hint;
        return ["universal", "codex"];
      },
    });
    const result = await runCli(["skills", "add", "-s", "chargebee-cli", ...(scope === "project" ? ["--path", project] : ["--global"])]);
    expect(result.exitCode).toBe(0);
    const expectedUniversal = scope === "project"
      ? join(project, ".agents/skills/chargebee-cli")
      : join(process.env.XDG_CONFIG_HOME || join(process.env.HOME!, ".config"), "agents/skills/chargebee-cli");
    const expectedCodex = scope === "project"
      ? join(project, ".agents/skills/chargebee-cli")
      : join(process.env.CODEX_HOME || join(process.env.HOME!, ".codex"), "skills/chargebee-cli");
    expect(hints.universal).toBe(expectedUniversal);
    expect(hints.codex).toBe(expectedCodex);
    expect(existsSync(join(hints.universal!, "SKILL.md"))).toBe(true);
    expect(existsSync(join(hints.codex!, "SKILL.md"))).toBe(true);
  });

  it("prompts for add scope and agents, then updates selected global installations", async () => {
    terminal(true);
    __setPromptsForTest({ select: async () => "global", multiselect: async () => ["cursor", "claude-code"] });
    expect((await runCli(["skills", "add"])).exitCode).toBe(0);
    const cursor = join(process.env.HOME!, ".cursor/skills/chargebee-cli/SKILL.md");
    const claude = join(process.env.HOME!, ".claude/skills/chargebee-cli/SKILL.md");
    writeFileSync(cursor, "old cursor");
    writeFileSync(claude, "old claude");
    __setPromptsForTest({ multiselect: async () => [0] });
    expect((await runCli(["skills", "update", "chargebee-cli"])).exitCode).toBe(0);
    expect(readFileSync(cursor, "utf8")).toContain("name: chargebee-cli");
    expect(readFileSync(claude, "utf8")).toBe("old claude");
  });

  it.each([false, true, Symbol.for("cancel")])("remove honors confirmation %s after selecting installations", async (answer) => {
    await runCli(["skills", "add", "--path", project, "-a", "cursor", "-a", "claude-code"]);
    terminal(true);
    __setPromptsForTest({ multiselect: async () => [0], confirm: async () => answer, isCancel: (value) => typeof value === "symbol", cancel: () => {} });
    const result = await runCli(["skills", "remove", "--path", project]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(project, ".cursor/skills/chargebee-cli"))).toBe(answer !== true);
    expect(existsSync(join(project, ".claude/skills/chargebee-cli"))).toBe(true);
  });

  it.each(["add", "update", "remove"])("cancelling %s scope leaves files untouched", async (operation) => {
    await runCli(["skills", "add", "-g", "-a", "cursor"]);
    terminal(true);
    __setPromptsForTest({ select: async () => Symbol.for("cancel"), isCancel: (value) => typeof value === "symbol", cancel: () => {} });
    expect((await runCli(["skills", operation])).exitCode).toBe(0);
    expect(existsSync(join(process.env.HOME!, ".cursor/skills/chargebee-cli/SKILL.md"))).toBe(true);
  });

  it.each(["update", "remove"])("cancelling %s installation selection leaves files untouched", async (operation) => {
    await runCli(["skills", "add", "--path", project, "-a", "cursor"]);
    terminal(true);
    __setPromptsForTest({ multiselect: async () => Symbol.for("cancel"), isCancel: (value) => typeof value === "symbol", cancel: () => {} });
    expect((await runCli(["skills", operation, "--path", project])).exitCode).toBe(0);
    expect(existsSync(join(project, ".cursor/skills/chargebee-cli/SKILL.md"))).toBe(true);
  });

  it("update --yes falls back to global while --project prevents fallback", async () => {
    mkdirSync(project);
    const cwd = process.cwd();
    process.chdir(project);
    try {
      await runCli(["skills", "add", "-g", "-a", "cursor"]);
      const path = join(process.env.HOME!, ".cursor/skills/chargebee-cli/SKILL.md");
      writeFileSync(path, "old");
      expect((await runCli(["skills", "update", "-p", "-y"])).stdout).toContain("not installed");
      expect(readFileSync(path, "utf8")).toBe("old");
      expect((await runCli(["skills", "list", "-p"])).stdout).not.toContain("  Global\n");
      expect((await runCli(["skills", "update", "-y"])).exitCode).toBe(0);
      expect(readFileSync(path, "utf8")).toContain("name: chargebee-cli");
    } finally { process.chdir(cwd); }
  });

  it.each(["--list", "-l"])("add %s lists available skills without installing or selecting an agent", async (flag) => {
    const result = await runCli(["skills", "add", flag, "--path", project]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Available skills:");
    expect(result.stdout).toContain("chargebee-cli");
    expect(result.stdout).toContain("API discovery");
    expect(result.stdout).toContain("chargebee skills list");
    expect(result.stdout).not.toContain("Installing");
    expect(existsSync(project)).toBe(false);
  });

  it("add help advertises available skill discovery", async () => {
    const result = await runCli(["skills", "add", "--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("-l, --list");
    expect(result.stdout).toContain("-s, --skill <name>");
    expect(result.stdout).toMatch(/without\s+installing/);
    expect(result.stdout).toContain("-a, --agent");
    expect(result.stdout).toContain("-g, --global");
    expect(result.stdout).not.toContain("--ide");
  });

  it("supports repeated agents and isolates project and global mutations", async () => {
    mkdirSync(project);
    const cwd = process.cwd();
    process.chdir(project);
    try {
      const home = process.env.HOME!;
      const globalFile = join(home, ".cursor/skills/chargebee-cli/SKILL.md");
      const localFile = join(project, ".cursor/skills/chargebee-cli/SKILL.md");
      const added = await runCli(["skills", "add", "-g", "-a", "cursor", "-a", "claude-code", "-y"]);
      expect(added.exitCode).toBe(0);
      expect(existsSync(globalFile)).toBe(true);
      expect(existsSync(join(home, ".claude/skills/chargebee-cli/SKILL.md"))).toBe(true);
      expect(existsSync(localFile)).toBe(false);
      expect(existsSync(join(home, ".gitignore"))).toBe(false);
      expect((await runCli(["skills", "add", "-a", "cursor"])).exitCode).toBe(0);

      const listed = await runCli(["skills", "list", "-a", "cursor"]);
      expect(listed.stdout).toContain("  Project\n");
      expect(listed.stdout).toContain("  Global\n");
      expect(listed.stdout.indexOf("  Global\n")).toBeLessThan(listed.stdout.indexOf("  Project\n"));
      expect(listed.stdout).toContain(join(home, ".cursor/skills/chargebee-cli"));
      expect(listed.stdout).toContain(join(project, ".cursor/skills/chargebee-cli"));
      const globalList = await runCli(["skills", "list", "-g", "-a", "cursor"]);
      expect(globalList.stdout).not.toContain("  Project\n");
      expect(globalList.stdout).not.toContain("Claude Code");

      writeFileSync(globalFile, "global content");
      writeFileSync(localFile, "local content");
      expect((await runCli(["skills", "update", "-a", "cursor"])).exitCode).toBe(0);
      expect(readFileSync(globalFile, "utf8")).toBe("global content");
      expect(readFileSync(localFile, "utf8")).toContain("name: chargebee-cli");
      expect((await runCli(["skills", "update", "-g", "-a", "cursor"])).exitCode).toBe(0);
      expect(readFileSync(globalFile, "utf8")).toContain("name: chargebee-cli");
      expect((await runCli(["skills", "remove", "-y", "-a", "cursor"])).exitCode).toBe(0);
      expect(existsSync(globalFile)).toBe(true);
      expect(existsSync(localFile)).toBe(false);
      expect((await runCli(["skills", "remove", "-g", "-y"])).exitCode).toBe(0);
      expect(existsSync(globalFile)).toBe(false);
      expect(existsSync(join(home, ".claude/skills/chargebee-cli"))).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  it("project update/removal from home cannot touch global installations", async () => {
    const home = process.env.HOME!;
    await runCli(["skills", "add", "-g", "-a", "cursor", "-a", "claude-code"]);
    await runCli(["skills", "add", "--path", home, "-a", "universal"]);
    const cursor = join(home, ".cursor/skills/chargebee-cli/SKILL.md");
    const claude = join(home, ".claude/skills/chargebee-cli/SKILL.md");
    writeFileSync(cursor, "global cursor");
    writeFileSync(claude, "global claude");
    const cwd = process.cwd();
    process.chdir(home);
    try {
      expect((await runCli(["skills", "update", "-p", "-y"])).exitCode).toBe(0);
      expect(readFileSync(cursor, "utf8")).toBe("global cursor");
      terminal(true);
      __setPromptsForTest({
        multiselect: async (opts: { initialValues: number[]; options: Array<{ label: string }> }) => {
          expect(opts.initialValues).toEqual([]);
          expect(opts.options.map((option) => option.label)).toEqual(["codex, universal"]);
          return [0];
        },
        confirm: async () => true,
      });
      const removed = await runCli(["skills", "remove", "-p"]);
      expect(removed.exitCode).toBe(0);
      expect(removed.stdout).not.toContain(".cursor/skills");
      expect(removed.stdout).not.toContain(".claude/skills");
      expect(readFileSync(cursor, "utf8")).toBe("global cursor");
      expect(readFileSync(claude, "utf8")).toBe("global claude");
      expect(existsSync(join(home, ".agents/skills/chargebee-cli"))).toBe(false);

      __setPromptsForTest({
        multiselect: async (opts: { initialValues: number[]; options: Array<{ label: string }> }) => {
          expect(opts.initialValues).toEqual([]);
          return [opts.options.findIndex((option) => option.label === "cursor")];
        },
      });
      const globalRemoval = await runCli(["skills", "remove", "-g"]);
      expect(globalRemoval.exitCode).toBe(0);
      expect(globalRemoval.stdout).toContain(".cursor/skills/chargebee-cli");
      expect(globalRemoval.stdout).not.toContain(".claude/skills");
      expect(existsSync(cursor)).toBe(false);
      expect(readFileSync(claude, "utf8")).toBe("global claude");
    } finally { process.chdir(cwd); }
  });

  it("project aliases of a global directory are excluded even with explicit agent selection", async () => {
    await runCli(["skills", "add", "-g", "-a", "cursor"]);
    mkdirSync(join(project, ".cursor/skills"), { recursive: true });
    const globalPath = join(process.env.HOME!, ".cursor/skills/chargebee-cli");
    symlinkSync(globalPath, join(project, ".cursor/skills/chargebee-cli"));
    writeFileSync(join(globalPath, "SKILL.md"), "keep global");
    for (const operation of ["update", "remove"]) {
      const result = await runCli(["skills", operation, "--path", project, "-a", "cursor", "-y"]);
      expect(result.stdout + result.stderr).toContain("not installed");
      expect(readFileSync(join(globalPath, "SKILL.md"), "utf8")).toBe("keep global");
    }
  });

  it("lists duplicate home destinations only under Global and groups shared agents", async () => {
    const home = process.env.HOME!;
    await runCli(["skills", "add", "-g", "-a", "cursor", "-a", "claude-code", "-a", "codex"]);
    await runCli(["skills", "add", "--path", home, "-a", "universal"]);
    const cwd = process.cwd();
    process.chdir(home);
    try {
      const listed = await runCli(["skills", "list"]);
      expect(listed.exitCode).toBe(0);
      const [global, projectSection] = listed.stdout.split("  Project\n");
      expect(global).toContain("  Global\n");
      expect(global).toContain("Cursor");
      expect(global).toContain("Claude Code");
      expect(projectSection).not.toContain("Cursor");
      expect(projectSection).not.toContain("Claude Code");
      expect(projectSection).toContain("Codex, Universal");
      for (const dir of [".cursor", ".claude", ".codex", ".agents"]) {
        expect(listed.stdout.split(`${dir}/skills/chargebee-cli`)).toHaveLength(2);
      }
      const projectOnly = await runCli(["skills", "list", "-p"]);
      expect(projectOnly.stdout).not.toContain("  Global\n");
      expect(projectOnly.stdout).not.toContain("Cursor");
      expect(projectOnly.stdout).toContain("Codex, Universal");
      const filtered = await runCli(["skills", "list", "-a", "cursor"]);
      expect(filtered.stdout).toContain("  Global\n");
      expect(filtered.stdout).not.toContain("  Project\n");
      expect(filtered.stdout).not.toContain("Claude Code");
    } finally {
      process.chdir(cwd);
    }
  });

  it.each(["add", "list", "update", "remove"])("%s rejects conflicting scopes and the old IDE flag", async (command) => {
    const conflict = await runCli(["skills", command, "--global", "--path", project]);
    expect(conflict.exitCode).not.toBe(0);
    expect(conflict.stderr).toContain("cannot be used with");
    const legacy = await runCli(["skills", command, "--ide", "cursor"]);
    expect(legacy.exitCode).not.toBe(0);
    expect(legacy.stderr).toContain("unknown option");
    expect(existsSync(project)).toBe(false);
  });

  it("installs Codex and Universal in their global paths and the shared project path", async () => {
    const home = process.env.HOME!;
    expect((await runCli(["skills", "add", "-g", "-a", "codex", "-a", "universal"])).exitCode).toBe(0);
    expect(existsSync(join(home, ".codex/skills/chargebee-cli/SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".config/agents/skills/chargebee-cli/SKILL.md"))).toBe(true);
    expect((await runCli(["skills", "add", "--path", project, "-a", "codex", "-a", "universal"])).exitCode).toBe(0);
    expect(existsSync(join(project, ".agents/skills/chargebee-cli/SKILL.md"))).toBe(true);
    expect((await runCli(["skills", "update", "--path", project])).exitCode).toBe(0);
    const legacy = join(project, ".ai/skills/chargebee-cli");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, ".skill-meta.json"), "{}");
    expect((await runCli(["skills", "remove", "--path", project, "-y"])).exitCode).toBe(0);
    expect(existsSync(join(project, ".agents/skills/chargebee-cli"))).toBe(false);
    expect(existsSync(legacy)).toBe(true);
  });

  it("honors global agent configuration directories", async () => {
    for (const key of agentEnv) process.env[key] = join(root, key);
    expect((await runCli(["skills", "add", "-g", "-a", "codex", "-a", "claude-code", "-a", "universal"])).exitCode).toBe(0);
    expect(existsSync(join(root, "CODEX_HOME/skills/chargebee-cli/SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "CLAUDE_CONFIG_DIR/skills/chargebee-cli/SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "XDG_CONFIG_HOME/agents/skills/chargebee-cli/SKILL.md"))).toBe(true);
    const listed = await runCli(["skills", "list", "-g"]);
    expect(listed.stdout).toContain(join(root, "CODEX_HOME/skills/chargebee-cli"));
  });

  it("keeps legacy generic installs discoverable and refreshable as universal", async () => {
    const legacy = join(project, ".ai/skills/chargebee-cli");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, ".skill-meta.json"), JSON.stringify({ ide: "generic", source: "embedded" }));
    writeFileSync(join(legacy, "SKILL.md"), "old skill");
    expect((await runCli(["skills", "list", "--path", project, "-a", "universal"])).stdout).toContain(legacy);
    expect((await runCli(["skills", "update", "--path", project, "-a", "universal"])).exitCode).toBe(0);
    expect(readFileSync(join(legacy, "SKILL.md"), "utf8")).toContain("name: chargebee-cli");
    expect(existsSync(join(project, ".agents"))).toBe(false);
    expect((await runCli(["skills", "remove", "-y", "--path", project, "-a", "universal"])).exitCode).toBe(0);
    expect(existsSync(legacy)).toBe(false);
  });

  it("--yes detects agents and errors when none are available", async () => {
    const missing = await runCli(["skills", "add", "-y", "--path", project]);
    expect(missing.exitCode).not.toBe(0);
    expect(existsSync(project)).toBe(false);
    mkdirSync(join(process.env.HOME!, ".codex"), { recursive: true });
    expect((await runCli(["skills", "add", "-y", "--path", project])).exitCode).toBe(0);
    expect(existsSync(join(project, ".agents/skills/chargebee-cli/SKILL.md"))).toBe(true);
  });

  it.each(["claude", "generic", "toString"])("rejects unsupported agent %s before writing", async (agent) => {
    const result = await runCli(["skills", "add", "-a", "cursor", "-a", agent, "--path", project]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unknown agent");
    expect(existsSync(project)).toBe(false);
  });

  it.each(["--skill", "-s"])("add %s installs the selected skill once", async (flag) => {
    const result = await runCli([
      "skills", "add", flag, "chargebee-cli", flag, "chargebee-cli",
      "--agent", "cursor", "--path", project, "--no-gitignore",
    ]);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(project, ".cursor/skills/chargebee-cli/SKILL.md"))).toBe(true);
    expect(result.stdout.match(/Installing Chargebee CLI skill/g)).toHaveLength(1);
  });

  it("rejects an unknown selection before installing any selected skill", async () => {
    const result = await runCli([
      "skills", "add", "-s", "chargebee-cli", "-s", "unknown-skill",
      "--agent", "cursor", "--path", project,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Unknown skill: unknown-skill");
    expect(result.stderr).toContain("chargebee skills add --list");
    expect(existsSync(project)).toBe(false);
  });

  it("requires a value for --skill", async () => {
    const result = await runCli(["skills", "add", "--skill"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("argument missing");
  });

  it("listing an explicitly selected skill does not install it", async () => {
    const result = await runCli([
      "skills", "add", "--skill", "chargebee-cli", "--list", "--path", project,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Available skills:");
    expect(existsSync(project)).toBe(false);
  });

  it("add / list / update / remove with --agent and --path", async () => {
    const added = await runCli([
      "skills",
      "add",
      "--agent",
      "cursor",
      "--path",
      project,
      "--no-gitignore",
    ]);
    expect(added.exitCode).toBe(0);
    expect(added.stdout).toContain("Installed");
    expect(
      existsSync(join(project, ".cursor/skills/chargebee-cli/SKILL.md")),
    ).toBe(true);

    const again = await runCli([
      "skills",
      "add",
      "--agent",
      "cursor",
      "--path",
      project,
      "--no-gitignore",
    ]);
    expect(again.stdout).toContain("already installed");
    expect(again.stdout).toContain("No new installations");

    const listed = await runCli([
      "skills",
      "list",
      "--agent",
      "cursor",
      "--path",
      project,
    ]);
    expect(listed.stdout).toContain("installed");
    expect(listed.stdout).toContain("Cursor");

    const updated = await runCli([
      "skills",
      "update",
      "--agent",
      "cursor",
      "--path",
      project,
    ]);
    expect(updated.exitCode).toBe(0);
    expect(updated.stdout).toContain("Updated");

    const removed = await runCli([
      "skills",
      "remove",
      "--yes",
      "--agent",
      "cursor",
      "--path",
      project,
    ]);
    expect(removed.exitCode).toBe(0);
    expect(removed.stdout).toContain("Removed");
    expect(existsSync(join(project, ".cursor/skills/chargebee-cli"))).toBe(
      false,
    );
  });

  it("list/remove/update when nothing is installed", async () => {
    const listed = await runCli([
      "skills",
      "list",
      "--agent",
      "cursor",
      "--path",
      project,
    ]);
    expect(listed.stdout).toContain("not installed");
    const removed = await runCli([
      "skills",
      "remove",
      "--yes",
      "--agent",
      "cursor",
      "--path",
      project,
    ]);
    expect(removed.exitCode).toBe(1);
    expect(removed.stderr).toContain("not installed");
    const updated = await runCli([
      "skills",
      "update",
      "--agent",
      "cursor",
      "--path",
      project,
    ]);
    expect(updated.exitCode).toBe(0);
    expect(updated.stdout).toContain("not installed");
  });

  it("remove requires confirmation without a terminal", async () => {
    await runCli([
      "skills",
      "add",
      "--agent",
      "cursor",
      "--path",
      project,
      "--no-gitignore",
    ]);
    await runCli([
      "skills",
      "add",
      "--agent",
      "claude-code",
      "--path",
      project,
      "--no-gitignore",
    ]);
    const { exitCode, stderr } = await runCli([
      "skills",
      "remove",
      "--path",
      project,
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--yes");
  });
});
