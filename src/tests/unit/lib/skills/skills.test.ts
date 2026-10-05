import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectAgents, findInstalledSkills, installSkill, isInstalled, parseAgent, refreshSkills, reinstallSkill, resolveAgentsForAdd, resolveSkillTargets, uninstallSkill } from "../../../../lib/skills/index.js";

describe("skills install", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "cb-skills-test-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("installs all 4 embedded files to cursor skills dir", async () => {
    const result = await installSkill(projectDir, "cursor", true);
    expect(result.filesAdded).toHaveLength(4);
    const base = join(projectDir, ".cursor/skills/chargebee-cli");
    expect(existsSync(join(base, "SKILL.md"))).toBe(true);
    expect(existsSync(join(base, "references/commands.md"))).toBe(true);
    expect(existsSync(join(base, "references/workflows.md"))).toBe(true);
    expect(existsSync(join(base, "references/composability.md"))).toBe(true);
    expect(existsSync(join(base, ".skill-meta.json"))).toBe(true);
    expect(readFileSync(join(base, "SKILL.md"), "utf-8")).toContain("name: chargebee-cli");
  });

  it("appends to existing .gitignore lacking the entry", async () => {
    mkdirSync(join(projectDir, ".git"));
    const gitignore = join(projectDir, ".gitignore");
    writeFileSync(gitignore, "node_modules\n");
    await installSkill(projectDir, "cursor", false);
    const contents = readFileSync(gitignore, "utf-8");
    expect(contents).toContain("node_modules");
    expect(contents).toContain(".cursor/skills/");
  });

  it("does not duplicate when .gitignore already has entry", async () => {
    mkdirSync(join(projectDir, ".git"));
    const gitignore = join(projectDir, ".gitignore");
    writeFileSync(gitignore, "# existing\n.cursor/skills/\n");
    await installSkill(projectDir, "cursor", false);
    const contents = readFileSync(gitignore, "utf-8");
    const count = contents.match(/\.cursor\/skills\//g)?.length ?? 0;
    expect(count).toBe(1);
  });

  it("noGitignore=true skips .gitignore write", async () => {
    mkdirSync(join(projectDir, ".git"));
    await installSkill(projectDir, "cursor", true);
    expect(existsSync(join(projectDir, ".gitignore"))).toBe(false);
  });

  it("leaves .gitignore untouched when the target dir is not a git work tree", async () => {
    // projectDir has no .git anywhere above it (tmpdir root isn't a repo either).
    await installSkill(projectDir, "cursor", false);
    expect(existsSync(join(projectDir, ".gitignore"))).toBe(false);
  });

  it("writes .gitignore when the target dir is inside a git work tree", async () => {
    mkdirSync(join(projectDir, ".git"));
    await installSkill(projectDir, "cursor", false);
    const contents = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    expect(contents).toContain(".cursor/skills/");
  });

  it("never writes ~/.gitignore when installing into $HOME, even if $HOME is a git work tree", async () => {
    const home = mkdtempSync(join(tmpdir(), "cb-skills-home-git-"));
    mkdirSync(join(home, ".git")); // e.g. a dotfiles repo
    const prevHome = process.env.HOME;
    try {
      process.env.HOME = home;
      await installSkill(home, "cursor", false);
      expect(existsSync(join(home, ".gitignore"))).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("isInstalled reflects install state", async () => {
    expect(await isInstalled(projectDir, "cursor")).toBe(false);
    await installSkill(projectDir, "cursor", true);
    expect(await isInstalled(projectDir, "cursor")).toBe(true);
  });

  it("uninstallSkill removes the skill dir", async () => {
    await installSkill(projectDir, "cursor", true);
    expect(await isInstalled(projectDir, "cursor")).toBe(true);
    await uninstallSkill(projectDir, "cursor");
    expect(await isInstalled(projectDir, "cursor")).toBe(false);
    expect(existsSync(join(projectDir, ".cursor/skills/chargebee-cli"))).toBe(false);
  });

  it("parseAgent rejects unknown Agent", () => {
    expect(() => parseAgent("vim")).toThrow(/Unknown agent/);
    expect(parseAgent("cursor")).toBe("cursor");
    expect(parseAgent("claude-code")).toBe("claude-code");
    expect(parseAgent("universal")).toBe("universal");
  });

  it("writes .skill-meta.json with correct agent + name", async () => {
    await installSkill(projectDir, "claude-code", true);
    const meta = JSON.parse(
      readFileSync(join(projectDir, ".claude/skills/chargebee-cli/.skill-meta.json"), "utf-8")
    );
    expect(meta.name).toBe("chargebee-cli");
    expect(meta.agent).toBe("claude-code");
    expect(meta.source).toBe("embedded");
  });

  it("detectAgents finds cursor/claude config dirs under a home path", () => {
    const home = mkdtempSync(join(tmpdir(), "cb-skills-home-"));
    try {
      mkdirSync(join(home, ".cursor"));
      mkdirSync(join(home, ".claude"));
      expect(detectAgents(home).sort()).toEqual(["claude-code", "cursor"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("detectAgents() with no args follows HOME, not os.homedir()", () => {
    const home = mkdtempSync(join(tmpdir(), "cb-skills-home-env-"));
    const prevHome = process.env.HOME;
    try {
      mkdirSync(join(home, ".claude"));
      process.env.HOME = home;
      expect(detectAgents()).toEqual(["claude-code"]);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("findInstalledSkills discovers an install in another dir + Agent (the update bug)", async () => {
    // Mirrors install.sh (claude, installed under $HOME) vs bare `skills update`
    // (cursor, cwd): the install must still be discovered without matching flags.
    const home = mkdtempSync(join(tmpdir(), "cb-skills-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "cb-skills-cwd-"));
    try {
      await installSkill(home, "claude-code", true);
      const found = await findInstalledSkills([cwd, home]);
      expect(found).toEqual([{ projectDir: home, agent: "claude-code" }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("findInstalledSkills dedups the same dir+Agent and reports multiple agents", async () => {
    await installSkill(projectDir, "cursor", true);
    await installSkill(projectDir, "claude-code", true);
    // projectDir passed twice → each dir+Agent counted once.
    const found = await findInstalledSkills([projectDir, projectDir]);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.agent).sort()).toEqual(["claude-code", "cursor"]);
  });

  it("resolveSkillTargets with --agent returns that single target when installed", async () => {
    await installSkill(projectDir, "claude-code", true);
    const roots = { cwd: projectDir, home: join(projectDir, "home") };
    expect(await resolveSkillTargets({ agent: ["claude-code"] }, roots)).toEqual([
      { projectDir, agent: "claude-code" },
    ]);
    // Explicit but not installed → empty (caller decagents what to print).
    expect(await resolveSkillTargets({ agent: ["cursor"] }, roots)).toEqual([]);
  });

  it("resolveSkillTargets with --agent honors --path over cwd", async () => {
    const other = mkdtempSync(join(tmpdir(), "cb-skills-path-"));
    try {
      await installSkill(other, "cursor", true);
      const roots = { cwd: projectDir, home: join(projectDir, "home") };
      expect(await resolveSkillTargets({ agent: ["cursor"], path: other }, roots)).toEqual([
        { projectDir: other, agent: "cursor" },
      ]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("resolveSkillTargets with --path alone discovers every Agent under that path", async () => {
    await installSkill(projectDir, "cursor", true);
    await installSkill(projectDir, "claude-code", true);
    // cwd/home point elsewhere; --path must scope discovery to projectDir only.
    const elsewhere = mkdtempSync(join(tmpdir(), "cb-skills-else-"));
    try {
      const found = await resolveSkillTargets(
        { path: projectDir },
        { cwd: elsewhere, home: elsewhere }
      );
      expect(found.map((f) => f.agent).sort()).toEqual(["claude-code", "cursor"]);
      expect(found.every((f) => f.projectDir === projectDir)).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("resolveSkillTargets with no flags discovers across cwd + $HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "cb-skills-home2-"));
    try {
      await installSkill(projectDir, "cursor", true); // "cwd" install
      await installSkill(home, "claude-code", true); // "$HOME" install (matches install.sh)
      const found = await resolveSkillTargets({}, { cwd: projectDir, home }, true);
      expect(found).toEqual([
        { projectDir: home, agent: "claude-code", global: true },
        { projectDir, agent: "cursor" },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refreshSkills isolates a failing location and still processes the rest", async () => {
    await installSkill(projectDir, "cursor", true);
    // A projectDir nested under a regular file makes installSkill's mkdir throw.
    const blocker = join(projectDir, "blocker-file");
    writeFileSync(blocker, "not a dir");
    const badDir = join(blocker, "nested");

    // Failing location first — proves the loop continues to subsequent ones.
    const { succeeded, failed } = await refreshSkills([
      { projectDir: badDir, agent: "cursor" },
      { projectDir, agent: "cursor" },
    ]);

    expect(failed).toHaveLength(1);
    expect(failed[0]?.location.projectDir).toBe(badDir);
    expect(failed[0]?.error).toBeTruthy();
    expect(succeeded).toEqual([{ projectDir, agent: "cursor" }]);
    // The good location is genuinely reinstalled, not just reported.
    expect(await isInstalled(projectDir, "cursor")).toBe(true);
  });

  it("reinstallSkill restores the previous install when installation fails", async () => {
    await installSkill(projectDir, "cursor", true);
    const meta = join(projectDir, ".cursor/skills/chargebee-cli/.skill-meta.json");
    const before = readFileSync(meta, "utf-8");

    const boom = async () => {
      throw new Error("disk full");
    };
    await expect(reinstallSkill(projectDir, "cursor", boom)).rejects.toThrow("disk full");

    // Old install is intact (not missing, not partial) and no backup is left behind.
    expect(await isInstalled(projectDir, "cursor")).toBe(true);
    expect(readFileSync(meta, "utf-8")).toBe(before);
    expect(existsSync(join(projectDir, ".cursor/skills/chargebee-cli.bak"))).toBe(false);
  });

  it("reinstallSkill swaps in a fresh copy on success (no backup left)", async () => {
    await installSkill(projectDir, "cursor", true);
    // Plant a stale file that a real reinstall (fresh dir) should drop.
    const stale = join(projectDir, ".cursor/skills/chargebee-cli/stale.md");
    writeFileSync(stale, "old");

    await reinstallSkill(projectDir, "cursor");

    expect(await isInstalled(projectDir, "cursor")).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(projectDir, ".cursor/skills/chargebee-cli.bak"))).toBe(false);
  });

  it("resolveAgentsForAdd honors --agent without prompting", async () => {
    const stdin = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      expect(await resolveAgentsForAdd(["claude-code"])).toEqual(["claude-code"]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
    }
  });

  it("resolveAgentsForAdd returns detected agents non-interactively without guessing", async () => {
    const home = mkdtempSync(join(tmpdir(), "cb-skills-detected-"));
    const stdin = process.stdin.isTTY;
    const prevHome = process.env.HOME;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      mkdirSync(join(home, ".claude"));
      process.env.HOME = home;
      expect(await resolveAgentsForAdd()).toEqual(["claude-code"]);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("resolveAgentsForAdd exits 1 listing the --agent choices when non-TTY and nothing detected", async () => {
    const home = mkdtempSync(join(tmpdir(), "cb-skills-nodetect-"));
    const stdin = process.stdin.isTTY;
    const prevHome = process.env.HOME;
    const origExit = process.exit;
    const origError = console.error;
    const errors: string[] = [];
    console.error = (...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    };
    process.exit = ((code?: number) => {
      throw new Error(`exit ${code ?? 0}`);
    }) as typeof process.exit;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      process.env.HOME = home;
      await expect(resolveAgentsForAdd()).rejects.toThrow("exit 1");
      expect(errors.join("\n")).toContain("--agent");
      // Lists the available choices so the user knows what to pass.
      expect(errors.join("\n")).toContain("cursor");
      expect(errors.join("\n")).toContain("claude-code");
      expect(errors.join("\n")).toContain("universal");
    } finally {
      process.exit = origExit;
      console.error = origError;
      Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
