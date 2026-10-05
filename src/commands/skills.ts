import { InvalidArgumentError, Option, type Command } from "commander";

import {
  AGENT_CONFIGS,
  SKILL_NAME,
  parseAgent,
  skillInstallPath,
  type Agent,
  installSkill,
  isInstalled,
  refreshSkills,
  resolveAgentsForAdd,
  uninstallSkill,
} from "../lib/skills/index.js";
import { humanLog, diagnostic, exitCommand, jsonResult, isJsonMode, OutputError } from "../lib/output.js";
import { confirmRemoval, selectInstalledTargets, selectScope } from "../lib/skills/interaction.js";
import { listSkillInstallations } from "../lib/skills/list.js";
import { userHome } from "../lib/config/user-home.js";
import { setCommandGroup } from "./help.js";
import { sectionTitle } from "../lib/help-style.js";

interface SkillOptions {
  agent?: Agent[];
  path?: string;
  global?: boolean;
  project?: boolean;
  yes?: boolean;
  list?: boolean;
  skill?: string[];
  gitignore?: boolean;
}

export function registerSkillsCommand(program: Command): void {
  const skills = program
    .command("skills")
    .description("Manage Chargebee Agent Skills");

  setCommandGroup(skills, "core");
  skills.addHelpText("after", `
${sectionTitle("SCOPE")}
  add, update, and remove prompt for scope unless it is specified.
  Without a terminal or with --yes, add/remove default to the project.
  update uses project installations when present, otherwise global ones.
  list shows project and global installations.
  --global selects user-wide installations; --project the current project.
  --path selects another project.
  --global and --path cannot be combined. Agent filters do not change scope.
  A directory shared by global and project scope is global only.
  Removal starts with nothing selected; choose directories, then confirm.

${sectionTitle("EXAMPLES")}
  chargebee skills add --list
  chargebee skills add -g -a cursor -a claude-code -s chargebee-cli
  chargebee skills list --global
  chargebee skills update --global --agent cursor
  chargebee skills remove --global --agent cursor
`);

  const targetFlags = (cmd: Command) => cmd
    .option("-a, --agent <name>", "Target agent: cursor, claude-code, codex, universal (repeatable)",
      (name: string, agents: Agent[] = []) => [...new Set([...agents, parseAgent(name)])])
    .addOption(new Option("-g, --global", "Use user-wide installations").conflicts(["path", "project"]))
    .addOption(new Option("-p, --project", "Use project installations").conflicts("global"))
    .addOption(new Option("--path <dir>", "Use this project directory").conflicts("global"));

  const parseSkill = (name: string, selected: string[] = []) => {
    if (name !== SKILL_NAME) {
      throw new InvalidArgumentError(`Unknown skill: ${name}. Run 'chargebee skills add --list' to see available skills.`);
    }
    return [...new Set([...selected, name])];
  };
  const mutationFlags = (cmd: Command) => targetFlags(cmd)
    .option("-s, --skill <name>", "Select a skill (repeatable; default: chargebee-cli)", parseSkill)
    .option("-y, --yes", "Skip selection and confirmation prompts");

  mutationFlags(skills.command("add").description("Install Chargebee skills for coding agents"))
    .option("-l, --list", "List skills available to install without installing")
    .option("--no-gitignore", "Don't add skills directory to .gitignore")
    .action(async (opts: SkillOptions) => {
      if (opts.list) {
        if (jsonResult({ skills: [SKILL_NAME] })) return;
        humanLog("Available skills:");
        humanLog(`  ${SKILL_NAME}`);
        humanLog("    Chargebee CLI commands, API discovery, code generation, and workflow recipes");
        humanLog("\nRun 'chargebee skills add' to install.");
        humanLog("Run 'chargebee skills list' to check installed skills.");
        return;
      }

      if (isJsonMode() && !opts.agent?.length) throw new OutputError("input_required", "Specify --agent when installing skills with --json.");
      const selection = await selectScope(opts, "add");
      if (!selection) return;
      opts = { ...opts, ...selection };
      const projectDir = opts.global ? userHome() : opts.path || process.cwd();
      const agents = await resolveAgentsForAdd(opts.agent, opts.yes, { projectDir, global: opts.global });
      if (!agents) return;

      const skipGitignore = opts.gitignore === false;
      let installedAny = false;
      const installations: Array<{ agent: Agent; path: string; changed: boolean }> = [];

      for (const agent of agents) {
        if (await isInstalled(projectDir, agent, opts.global)) {
          installations.push({ agent, path: skillInstallPath(projectDir, agent, opts.global), changed: false });
          humanLog(`${AGENT_CONFIGS[agent].name}: already installed (skipped)`);
          continue;
        }

        humanLog(`Installing Chargebee CLI skill for ${AGENT_CONFIGS[agent].name}...`);
        const result = await installSkill(projectDir, agent, skipGitignore, opts.global);
        installations.push({ agent, path: result.installPath, changed: true });

        humanLog();
        humanLog(`✓ Installed to ${result.installPath}`);
        humanLog();
        humanLog("Files added:");
        for (const f of result.filesAdded) humanLog(`  - ${f}`);
        humanLog();
        installedAny = true;
      }

      jsonResult({ installations });
      if (!installedAny) {
        humanLog("No new installations. Use 'chargebee skills update' to refresh existing skills.");
        return;
      }

      const names = agents.map((agent) => AGENT_CONFIGS[agent].name).join(", ");
      humanLog(`Your AI assistant(s) (${names}) now have Chargebee CLI knowledge!`);
    });

  targetFlags(
    skills.command("list").description("List installed Chargebee skills across project and global scopes")
  ).action(async (opts: SkillOptions) => {
    const locations = await listSkillInstallations(opts);
    if (jsonResult({ installations: locations })) return;
    const installed = locations.length > 0;

    humanLog(`  chargebee-cli${installed ? "  (installed ✓)" : "  (not installed)"}`);
    humanLog("    Chargebee CLI commands, API discovery, code generation, and workflow recipes\n");
    for (const global of [true, false]) {
      const section = locations.filter((location) => location.global === global);
      if (!section.length) continue;
      humanLog(`  ${global ? "Global" : "Project"}`);
      for (const location of section) {
        humanLog(`    ${location.agents.map((agent) => AGENT_CONFIGS[agent].name).join(", ")}`);
        humanLog(`      ${location.path}`);
      }
      humanLog();
    }
    if (!installed) humanLog("  Run 'chargebee skills add' to install.");
  });

  mutationFlags(
    skills.command("remove").description("Remove installed Chargebee skills")
      .argument("[skills...]", "Skills to remove", parseSkill)
  ).action(async (_names: string[], opts: SkillOptions) => {
    const selection = await selectScope(opts, "remove");
    if (!selection) return;
    const locations = await selectInstalledTargets(selection, "remove");
    if (!locations) return;

    if (locations.length === 0) {
      diagnostic("Chargebee CLI skill is not installed.");
      exitCommand(1);
    }

    if (!await confirmRemoval(locations, opts.yes)) return;

    const removals = locations.map((location) => ({
      ...location,
      path: skillInstallPath(location.projectDir, location.agent, location.global),
    }));
    jsonResult({ removed: removals.map(({ agent, path }) => ({ agent, path })) });
    for (const { projectDir, agent, global, path } of removals) {
      await uninstallSkill(projectDir, agent, global, path);
      humanLog(`✓ Removed chargebee-cli skill (${AGENT_CONFIGS[agent].name}: ${projectDir})`);
    }
  });

  mutationFlags(
    skills.command("update").description("Refresh installed Chargebee skills")
      .argument("[skills...]", "Skills to update", parseSkill)
  ).action(async (_names: string[], opts: SkillOptions) => {
    const selection = await selectScope(opts, "update");
    if (!selection) return;
    const locations = await selectInstalledTargets(selection, "update");
    if (!locations) return;

    if (locations.length === 0) {
      jsonResult({ updated: [] });
      humanLog("Chargebee CLI skill is not installed. Use 'chargebee skills add' to install.");
      return;
    }

    humanLog("Updating chargebee-cli skill...");
    const { succeeded, failed } = await refreshSkills(locations);
    jsonResult({ updated: succeeded });
    if (isJsonMode() && failed.length) throw new OutputError("partial_failure", "Some skill installations could not be updated.", { updated: succeeded, failed });
    for (const { projectDir, agent } of succeeded) {
      humanLog(`  ✓ ${AGENT_CONFIGS[agent].name} (${projectDir})`);
    }
    for (const { location, error } of failed) {
      diagnostic(`  ✗ ${AGENT_CONFIGS[location.agent].name} (${location.projectDir}): ${error}`);
    }

    if (failed.length > 0) {
      diagnostic(`Failed to update ${failed.length} of ${locations.length} location(s).`);
      exitCommand(1);
    }
    humanLog("✓ Updated chargebee-cli skill");
  });
}
