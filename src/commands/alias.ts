import type { Command } from "commander";

import {
  DEFAULT_ALIAS_NAME,
  removeAlias,
  setAlias,
  showAlias,
} from "../lib/alias.js";
import { diagnostic, exitCommand } from "../lib/output.js";
import { setCommandGroup } from "./help.js";
import { sectionTitle } from "../lib/help-style.js";

export function registerAliasCommand(program: Command): void {
  const alias = program
    .command("alias")
    .description("Manage a shell alias for the chargebee command")
    .argument("<action>", "set, remove, or show")
    .argument("[name]", `Alias name (default: ${DEFAULT_ALIAS_NAME})`)
    .option("--force", "Add the alias even if one with the same name already exists")
    .addHelpText(
      "after",
      `\n${sectionTitle("EXAMPLES")}\n` +
        "  chargebee alias set\n" +
        "  chargebee alias set chb\n" +
        "  chargebee alias show\n" +
        "  chargebee alias remove\n",
    )
    .action(async (action: string, name: string | undefined, options: { force?: boolean }) => {
      const aliasName = name ?? DEFAULT_ALIAS_NAME;

      switch (action.toLowerCase()) {
        case "set":
          await setAlias(aliasName, { force: options.force });
          break;
        case "remove":
          await removeAlias(aliasName);
          break;
        case "show":
          await showAlias();
          break;
        default:
          diagnostic(`Unknown action: ${action} (use set, remove, or show)`);
          exitCommand(1);
      }
    });

  setCommandGroup(alias, "more");
}
