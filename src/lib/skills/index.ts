import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { diagnostic, exitCommand } from "../output.js";
import { canPrompt } from "../prompts.js";
import { userHome } from "../config/user-home.js";

// Static text imports — Bun embeds these into the compiled binary.
import skillMd from "./content/SKILL.md" with { type: "text" };
import commandsMd from "./content/references/commands.md" with { type: "text" };
import workflowsMd from "./content/references/workflows.md" with { type: "text" };
import composabilityMd from "./content/references/composability.md" with { type: "text" };

/** Supported coding agents and the shared installation target. */
export type Agent = "cursor" | "claude-code" | "codex" | "universal";

/**
 * Per-agent install layout. `skillsDir` is the project-relative directory the agent scans
 * for skills; `gitignoreEntry` is the path written to the project's `.gitignore`.
 */
export const AGENT_CONFIGS: Record<Agent, { name: string; skillsDir: string; gitignoreEntry: string }> = {
  cursor: { name: "Cursor", skillsDir: ".cursor/skills", gitignoreEntry: ".cursor/skills/" },
  "claude-code": { name: "Claude Code", skillsDir: ".claude/skills", gitignoreEntry: ".claude/skills/" },
  codex: { name: "Codex", skillsDir: ".agents/skills", gitignoreEntry: ".agents/skills/" },
  universal: { name: "Universal", skillsDir: ".agents/skills", gitignoreEntry: ".agents/skills/" },
};

export function skillInstallPath(projectDir: string, agent: Agent, global = false): string {
  let base = join(projectDir, AGENT_CONFIGS[agent].skillsDir);
  if (global && agent === "codex") base = join(process.env.CODEX_HOME || join(projectDir, ".codex"), "skills");
  if (global && agent === "claude-code") base = join(process.env.CLAUDE_CONFIG_DIR || join(projectDir, ".claude"), "skills");
  if (global && agent === "universal") base = join(process.env.XDG_CONFIG_HOME || join(projectDir, ".config"), "agents/skills");
  // Keep earlier generic installs manageable without accepting the old CLI name.
  if (agent === "universal" && !existsSync(join(base, SKILL_NAME, ".skill-meta.json"))) {
    const legacy = resolve(projectDir, ".ai/skills", SKILL_NAME);
    if (existsSync(join(legacy, ".skill-meta.json"))) return legacy;
  }
  return resolve(base, SKILL_NAME);
}

export const SKILL_NAME = "chargebee-cli";

const EMBEDDED_FILES: Array<[string, string]> = [
  ["SKILL.md", skillMd],
  ["references/commands.md", commandsMd],
  ["references/workflows.md", workflowsMd],
  ["references/composability.md", composabilityMd],
];

/** Parse and validate an agent name. Throws on unknown values. */
export function parseAgent(s: string): Agent {
  const lower = s.toLowerCase() as Agent;
  if (Object.hasOwn(AGENT_CONFIGS, lower)) return lower;
  throw new Error(`Unknown agent: ${s}. Use: ${Object.keys(AGENT_CONFIGS).join(", ")}`);
}

/**
 * Guess which agents the user likely has, based on config dirs under $HOME.
 * Used to pre-select options in the interactive picker (same signal as install.sh).
 */
export function detectAgents(home = userHome()): Agent[] {
  const found: Agent[] = [];
  if (existsSync(join(home, ".cursor"))) found.push("cursor");
  if (existsSync(join(home, ".claude"))) found.push("claude-code");
  if (existsSync(join(home, ".codex"))) found.push("codex");
  return found;
}

/**
 * Resolve target agents for `skills add`.
 * - Explicit agents skip the picker.
 * - Otherwise → multiselect (space to toggle) when stdin is a TTY.
 * - Non-TTY fallback → all detected agents; with nothing detected there is no
 *   signal to guess from, so this prints the --agent choices and exits 1.
 * Returns null when the user cancels the picker.
 */
export async function resolveAgentsForAdd(
  explicitAgents?: string[],
  yes = false,
  target: { projectDir: string; global?: boolean } = { projectDir: process.cwd() }
): Promise<Agent[] | null> {
  if (explicitAgents?.length) return [...new Set(explicitAgents.map(parseAgent))];

  const detected = detectAgents();

  if (yes || !canPrompt()) {
    if (detected.length > 0) return detected;
    const choices = Object.keys(AGENT_CONFIGS).join(", ");
    diagnostic(`No agent detected — pass --agent <name> (choices: ${choices}).`);
    exitCommand(1);
  }

  const { multiselect, isCancel, cancel } = await import("../prompts.js");
  const result = await multiselect({
    message: "Select agents — space toggles, enter confirms",
    options: (Object.keys(AGENT_CONFIGS) as Agent[]).map((agent) => ({
      value: agent,
      label: AGENT_CONFIGS[agent].name,
      hint: skillInstallPath(target.projectDir, agent, target.global),
    })),
    initialValues: detected.length > 0 ? detected : ["cursor"],
    required: true,
  });

  if (isCancel(result)) {
    cancel("Cancelled.");
    return null;
  }

  return (result as string[]).map(parseAgent);
}

/**
 * True when `dir` sits inside a git work tree — a `.git` entry (directory,
 * or a file for worktrees/submodules) exists at `dir` or any ancestor — but
 * `dir` is not the user's home directory itself. Home is excluded even when
 * it happens to be a git work tree (e.g. a dotfiles repo), since we never
 * want to write to `~/.gitignore`.
 */
function isGitProjectDir(dir: string, home = userHome()): boolean {
  const target = resolve(dir);
  if (target === resolve(home)) return false;

  let current = target;
  for (;;) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Install the embedded Chargebee CLI skill to the target Agent's skills directory. */
export async function installSkill(
  projectDir: string,
  agent: Agent,
  noGitignore = false,
  global = false,
  installDir = skillInstallPath(projectDir, agent, global)
): Promise<{ installPath: string; filesAdded: string[] }> {
  const config = AGENT_CONFIGS[agent];

  const { mkdir, writeFile, readFile, appendFile } = await import("node:fs/promises");

  const filesAdded: string[] = [];
  for (const [relPath, contents] of EMBEDDED_FILES) {
    const dest = join(installDir, relPath);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, contents);
    filesAdded.push(join(installDir, relPath));
  }

  // Write metadata
  const meta = {
    name: SKILL_NAME,
    installedAt: new Date().toISOString(),
    source: "embedded",
    agent,
  };
  await writeFile(join(installDir, ".skill-meta.json"), JSON.stringify(meta, null, 2));

  // Add to .gitignore — only inside a real git work tree, and never $HOME itself.
  if (!global && !noGitignore && isGitProjectDir(projectDir)) {
    const gitignorePath = join(projectDir, ".gitignore");
    try {
      const existing = await readFile(gitignorePath, "utf-8");
      if (!existing.includes(config.gitignoreEntry)) {
        await appendFile(gitignorePath, `\n# Chargebee AI Skills\n${config.gitignoreEntry}\n`);
      }
    } catch {
      await writeFile(gitignorePath, `# Chargebee AI Skills\n${config.gitignoreEntry}\n`);
    }
  }

  return { installPath: installDir, filesAdded };
}

/** Check if the skill is installed. */
export async function isInstalled(projectDir: string, agent: Agent, global = false): Promise<boolean> {
  const metaPath = join(skillInstallPath(projectDir, agent, global), ".skill-meta.json");
  try {
    const { readFile } = await import("node:fs/promises");
    await readFile(metaPath, "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** A discovered skill installation: which Agent, in which project dir. */
export interface InstalledLocation {
  projectDir: string;
  agent: Agent;
  global?: boolean;
}

/**
 * Discover installed skills across agents within the supplied roots and scope.
 * Deduplicate identical root/agent pairs.
 */
export async function findInstalledSkills(
  projectDirs: string[] = [process.cwd()],
  global = false
): Promise<InstalledLocation[]> {
  const seen = new Set<string>();
  const found: InstalledLocation[] = [];
  for (const projectDir of projectDirs) {
    for (const agent of Object.keys(AGENT_CONFIGS) as Agent[]) {
      const key = `${projectDir}::${agent}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (await isInstalled(projectDir, agent, global)) found.push({ projectDir, agent, ...(global ? { global: true } : {}) });
    }
  }
  return found;
}

export async function resolveSkillTargets(
  opts: { agent?: string[]; path?: string; global?: boolean; project?: boolean },
  roots: { cwd: string; home: string } = { cwd: process.cwd(), home: userHome() },
  includeGlobal = false
): Promise<InstalledLocation[]> {
  if (opts.global && opts.path) throw new Error("--global and --path cannot be used together.");
  const agents = opts.agent?.map(parseAgent);
  const globals = await findInstalledSkills([roots.home], true);
  const globalPaths = new Set(await Promise.all(globals.map((location) => realpath(skillInstallPath(location.projectDir, location.agent, true)))));
  const projects = opts.global ? [] : await findInstalledSkills([opts.path || roots.cwd]);
  const projectPaths = await Promise.all(projects.map((location) => realpath(skillInstallPath(location.projectDir, location.agent))));
  const found = projects.filter((_, index) => !globalPaths.has(projectPaths[index]!));
  if (opts.global || (includeGlobal && !opts.path && !opts.project)) found.unshift(...globals);
  return found.filter((location) => !agents?.length || agents.includes(location.agent));
}

/** Outcome of {@link refreshSkills}: which locations updated, which failed and why. */
export interface RefreshResult {
  succeeded: InstalledLocation[];
  failed: Array<{ location: InstalledLocation; error: string }>;
}

/**
 * Rename the existing skill aside, install a fresh copy, then drop the backup.
 * On failure the backup is renamed back so a failed update never leaves a hole.
 * `install` is injectable so tests can force the restore path.
 */
export async function reinstallSkill(
  projectDir: string,
  agent: Agent,
  install: (projectDir: string, agent: Agent, global: boolean, path: string) => Promise<unknown> = (p, a, g, path) => installSkill(p, a, true, g, path),
  global = false
): Promise<void> {
  const skillDir = skillInstallPath(projectDir, agent, global);
  const backupDir = `${skillDir}.bak`;
  const { rename, rm } = await import("node:fs/promises");

  // Clear any stale backup from an earlier interrupted run, then stash the current
  // install so it stays intact until the replacement is fully written.
  await rm(backupDir, { recursive: true, force: true });
  const hadExisting = existsSync(skillDir);
  if (hadExisting) await rename(skillDir, backupDir);

  try {
    await install(projectDir, agent, global, skillDir);
    await rm(backupDir, { recursive: true, force: true });
  } catch (err) {
    // Roll back to the previous install: drop the partial copy, restore the backup.
    await rm(skillDir, { recursive: true, force: true });
    if (hadExisting) await rename(backupDir, skillDir);
    throw err;
  }
}

export async function refreshSkills(locations: InstalledLocation[]): Promise<RefreshResult> {
  const succeeded: InstalledLocation[] = [];
  const failed: RefreshResult["failed"] = [];
  const refreshed = new Set<string>();
  for (const location of locations) {
    try {
      const path = skillInstallPath(location.projectDir, location.agent, location.global);
      if (!refreshed.has(path)) {
        await reinstallSkill(location.projectDir, location.agent, undefined, location.global);
        refreshed.add(path);
      }
      succeeded.push(location);
    } catch (err) {
      failed.push({ location, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { succeeded, failed };
}

/** Remove the installed skill. */
export async function uninstallSkill(projectDir: string, agent: Agent, global = false, skillDir = skillInstallPath(projectDir, agent, global)): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(skillDir, { recursive: true, force: true });
}
