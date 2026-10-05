import type { Command } from "commander";

/**
 * Walk argv against registered subcommands only. Stops at the first token that
 * is not a command name (so positional ids never become the event name).
 */
export function knownCommandPath(program: Command, argv: string[]): string {
  const tokens = argv.filter((a) => a !== "--" && !a.startsWith("-"));
  const names: string[] = [];
  let cmd: Command = program;
  for (const token of tokens) {
    const next: Command | undefined = cmd.commands.find(
      (c) => c.name() === token || c.aliases().includes(token),
    );
    if (!next) break;
    names.push(next.name());
    cmd = next;
  }
  return names.join(" ");
}
