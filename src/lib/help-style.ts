/**
 * Shared styling for Commander-rendered help, so subcommand help matches the
 * root help in `commands/help.ts`: UPPERCASE bold section titles, "Show help"
 * wording, and help (not an error) when a command group is run bare.
 * Commander's own one-line `Usage:` header is kept as-is.
 */
import { Help, type Command, type HelpContext } from "commander";

import { colorEnabled } from "./ui/color.js";

/** Bold section title. Commander strips ANSI when the target stream has no color. */
export function sectionTitle(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

/** Commander heading ("Options:", "Profile commands:") → root-help style ("OPTIONS"). */
export function helpHeading(heading: string): string {
  return heading.replace(/:$/, "").toUpperCase();
}

const helpStyle: Partial<Help> = {
  styleTitle: (str: string) => sectionTitle(str),
  formatItemList(heading: string, items: string[], helper: Help): string[] {
    return Help.prototype.formatItemList.call(this, helpHeading(heading), items, helper);
  },
};

/**
 * Install after registering commands. The root keeps its custom
 * `helpInformation`; applying `configureHelp` to it would also be inherited by
 * commands registered later, so styling is set per command instead.
 */
export function configureHelpStyle(program: Command): void {
  const configure = (command: Command, isRoot: boolean) => {
    command.helpOption("-h, --help", "Show help");
    if (command.createHelp().visibleCommands(command).some((c) => c.name() === "help")) {
      command.helpCommand("help [command]", "Show help for a command");
    }
    command.configureOutput({
      getOutHasColors: () => colorEnabled(),
      getErrHasColors: () => colorEnabled({ stdoutIsTTY: Boolean(process.stderr.isTTY) }),
    });
    if (!isRoot) command.configureHelp(helpStyle);

    // A bare command group (`chargebee`, `chargebee customer`) is a request for
    // help, not an error. Commander would print it to stderr and exit 1; send it
    // to stdout and exit 0 like `--help`.
    const help = command.help.bind(command);
    command.help = ((context?: HelpContext) =>
      help(command.args.length === 0 ? { ...context, error: false } : context)) as Command["help"];

    for (const child of command.commands) configure(child, false);
  };
  configure(program, true);
}
