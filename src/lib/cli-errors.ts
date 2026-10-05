/**
 * Process-wide CLI error handling.
 *
 * Generated API actions already catch via `handleSdkError`. Throws from hooks,
 * built-in commands, and config validation used to escape `program.parse()` and
 * dump a Bun/Node stack. `runProgram` is the single boundary that prints a
 * clean message and exits.
 */
import { CommanderError, type Command } from "commander";

import { handleSdkError } from "./api/print.js";
import { exitAfterOutput, OutputExit } from "./output.js";

/** Appended after Commander unknown-command / unknown-option errors. */
export const HELP_AFTER_ERROR = "Run with --help to see available commands.";

/** Inherit to subcommands: keep Commander's suggestion, add a --help pointer. */
export function configureCliErrors(program: Command): void {
  program.showHelpAfterError(HELP_AFTER_ERROR);
  program.showSuggestionAfterError(true);
}

/**
 * Parse and dispatch. Commander already prints unknown-command/option and
 * process.exits; this catch is for thrown `Error`s (validation, hooks, …).
 */
export async function runProgram(
  program: Command,
  argv: readonly string[] = process.argv,
  from: "node" | "user" = "node",
): Promise<void> {
  try {
    await program.parseAsync([...argv], { from });
  } catch (err) {
    if (err instanceof OutputExit) {
      process.exitCode = err.exitCode;
      return;
    }
    if (err instanceof CommanderError) {
      process.exit(err.exitCode);
    }
    handleSdkError(err);
  }
}

/** Last-resort handlers for anything that still escapes parseAsync. */
export function installFatalHandlers(): void {
  const fail = (err: unknown): void => {
    try {
      handleSdkError(err, { unexpected: true });
    } catch (exit) {
      if (!(exit instanceof OutputExit)) throw exit;
      exitAfterOutput(exit.exitCode);
    }
  };
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
}
