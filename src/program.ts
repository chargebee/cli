import { configureJsonOutput } from "./lib/json-command.js";
import { configureHelpStyle } from "./lib/help-style.js";
import { Command } from "commander";

import { registerAliasCommand } from "./commands/alias.js";
import { registerAuthCommand } from "./commands/auth.js";
import { registerDocsCommand } from "./commands/docs.js";
import { registerFeedbackCommand } from "./commands/feedback.js";
import { registerListenCommand } from "./commands/listen.js";
import { registerOpenCommand } from "./commands/open.js";
import { registerResourcesCommand } from "./commands/resources.js";
import { registerSkillsCommand } from "./commands/skills.js";
import { registerTelemetryCommand } from "./commands/telemetry.js";
import { registerUpdateCommand } from "./commands/update.js";
import { getCommandGroup, renderHelp } from "./commands/help.js";
import { registerAll } from "./commands/generated/registry.js";
import { configureCliErrors } from "./lib/cli-errors.js";
import { setProfile } from "./lib/api/sdk.js";

/**
 * `--use-profile` selects which Chargebee site this invocation talks to.
 * Honor it for API resources, dashboard `open`, and webhook `listen`.
 * Reject it on auth (including status/whoami) and other non-site commands.
 */
function allowsUseProfile(cmd: Command): boolean {
  const name = cmd.name();
  if (name === "listen" || name === "open") return true;
  return getCommandGroup(cmd) === "resource";
}

export function buildProgram(version: string): Command {
  const program = new Command();
  configureCliErrors(program);

  program
    .name("chargebee")
    .description("Chargebee CLI — Build with Chargebee from the terminal")
    .version(version, "-v, --version", "Print the CLI version")
    .option("--json", "Output structured JSON without interactive prompts")
    .option("--use-profile <profile>", "Use a named profile for this command")
    .hook("preSubcommand", (thisCommand, actionCommand) => {
      const opts = { ...thisCommand.opts(), ...actionCommand.opts() };
      if (opts.useProfile) {
        if (!allowsUseProfile(actionCommand)) {
          throw new Error(
            `--use-profile is only valid for API commands, open, and listen.\n\n` +
              `  It selects which Chargebee site this invocation uses, and does not apply to auth, docs, or other non-site commands.\n` +
              `  To switch the saved active profile: chargebee auth switch ${opts.useProfile}`,
          );
        }
        setProfile(opts.useProfile);
      }
    });

  registerAuthCommand(program);
  registerDocsCommand(program);
  registerListenCommand(program);
  registerSkillsCommand(program);
  registerOpenCommand(program);
  registerFeedbackCommand(program);
  registerAliasCommand(program);
  registerTelemetryCommand(program);
  registerUpdateCommand(program);
  registerResourcesCommand(program);

  // Custom help for the root command only (don't use configureHelp — it inherits
  // to subcommands and hangs).
  program.addHelpText("beforeAll", "");
  program.helpInformation = () => `${renderHelp(program, version)}\n`;

  registerAll(program);

  configureHelpStyle(program);
  configureJsonOutput(program);
  return program;
}
