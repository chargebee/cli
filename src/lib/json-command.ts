import { CommanderError, type Command, type Option } from "commander";
import { diagnostic, exitCommand, finishOutput, isJsonMode, jsonResult, outputCompleted, withJsonOutput } from "./output.js";
import { handleSdkError } from "./api/print.js";

/** Inspect option tokens before parsing so usage errors also honor --json. */
export function wantsJson(program: Command, args: readonly string[]): boolean {
  const options = new Map<string, Option>();
  const visit = (cmd: Command) => {
    for (const option of cmd.options) {
      if (option.long) options.set(option.long, option);
      if (option.short) options.set(option.short, option);
    }
    for (const child of cmd.commands) visit(child);
  };
  visit(program);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") break;
    if (arg === "--json") return true;
    const option = options.get(arg);
    if (option?.required || (option?.optional && args[i + 1] && !args[i + 1]!.startsWith("-"))) i++;
  }
  return false;
}

function helpResult(command: Command): unknown {
  const inherited: Option[] = [];
  for (let parent = command.parent; parent; parent = parent.parent) inherited.push(...parent.options);
  const describeOptions = (options: readonly Option[]) => options.filter((o) => !o.hidden)
    .map((o) => ({ flags: o.flags, description: o.description }));
  return {
    name: command.name(), description: command.description(), aliases: command.aliases(),
    usage: command.usage(),
    arguments: command.registeredArguments.map((arg) => ({
      name: arg.name(), description: arg.description, required: arg.required, variadic: arg.variadic,
    })),
    global_options: describeOptions(inherited),
    options: describeOptions(command.options),
    commands: command.createHelp().visibleCommands(command)
      .map((c) => ({ name: c.name(), description: c.description(), aliases: c.aliases() })),
  };
}

/** Install after registering commands so every help path shares the same contract. */
export function configureJsonOutput(program: Command): void {
  const configure = (command: Command) => {
    command.exitOverride((err) => exitCommand(err.exitCode, err.code));
    const humanHelp = command.helpInformation.bind(command);
    command.helpInformation = (...args) => {
      if (isJsonMode()) {
        jsonResult(helpResult(command));
        return "";
      }
      return humanHelp(...args);
    };
    command.configureOutput({
      writeOut: (text) => {
        if (!isJsonMode()) process.stdout.write(text);
        else if (text.trim() === program.version()) jsonResult({ version: program.version() });
      },
      writeErr: (text) => {
        if (!isJsonMode()) process.stderr.write(text);
        else diagnostic(text);
      },
    });
    for (const child of command.commands) configure(child);
  };
  configure(program);
  const parse = program.parseAsync.bind(program);
  program.parseAsync = async (argv, options) => {
    const args = argv ?? process.argv;
    const userArgs = options?.from === "user" ? args : args.slice(options?.from === "electron" ? 1 : 2);
    if (!wantsJson(program, userArgs)) return parse(argv, options);
    return withJsonOutput(async () => {
      try {
        if (userArgs.every((arg) => arg === "--json")) {
          program.outputHelp();
          finishOutput();
          return program;
        }
        const result = await parse(argv, options);
        finishOutput();
        return result;
      } catch (err) {
        if (outputCompleted()) throw err; // process.exit replaced by a test double
        if (err instanceof CommanderError) {
          finishOutput(err.exitCode, err.code);
          if (err.exitCode === 0) return program;
          throw err;
        }
        handleSdkError(err);
      }
    });
  };
}
