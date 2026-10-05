import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Command } from "commander";

import { withJsonOutput } from "../../../lib/output.js";
import { HELP_AFTER_ERROR, installFatalHandlers, runProgram } from "../../../lib/cli-errors.js";

describe("runProgram", () => {
  let errorSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    stderrSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    exitSpy = spyOn(process, "exit").mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("prints a thrown Error message without the stack", async () => {
    const program = new Command();
    program.name("chargebee");
    program.exitOverride();
    program.command("boom").action(() => {
      const err = new Error('Invalid API host "staging"');
      err.stack =
        'Error: Invalid API host "staging"\n    at parseHost (/x/host.ts:98:13)\n    at setHostOverride (/x/sdk.ts:42:19)';
      throw err;
    });

    await runProgram(program, ["boom"], "user");

    expect(errorSpy).toHaveBeenCalledWith('Invalid API host "staging"');
    const printed = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(printed).not.toContain("parseHost");
    expect(printed).not.toContain("host.ts");
    expect(printed).not.toContain("at setHostOverride");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits with CommanderError.exitCode without dumping a stack", async () => {
    const program = new Command();
    program.name("chargebee");
    program.exitOverride();
    program.command("ok").action(() => {});

    await runProgram(program, ["not-a-command"], "user");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = [
      ...errorSpy.mock.calls.map((c: unknown[]) => String(c[0])),
      ...stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])),
    ].join("\n");
    expect(printed).toContain("unknown command");
    expect(printed).not.toContain(" at ");
    expect(printed).not.toContain("command.js");
  });
});

describe("HELP_AFTER_ERROR", () => {
  it("points at --help without dumping the full command list", () => {
    expect(HELP_AFTER_ERROR).toContain("--help");
    expect(HELP_AFTER_ERROR.toLowerCase()).not.toContain("customer");
  });
});

describe("installFatalHandlers", () => {
  it("routes uncaughtException and unhandledRejection through handleSdkError", () => {
    const handlers: Record<string, (err: unknown) => void> = {};
    const onSpy = spyOn(process, "on").mockImplementation(((
      event: string,
      fn: (err: unknown) => void,
    ) => {
      handlers[event] = fn;
      return process;
    }) as never);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = spyOn(process, "exit").mockImplementation((() => {}) as never);
    try {
      installFatalHandlers();
      expect(typeof handlers.uncaughtException).toBe("function");
      expect(typeof handlers.unhandledRejection).toBe("function");
      handlers.uncaughtException(new Error("boom"));
      handlers.unhandledRejection("rejected");
      const flush = (_chunk: unknown, callback: () => void) => { callback(); return true; };
      const stdout = spyOn(process.stdout, "write").mockImplementation(flush as never);
      const stderr = spyOn(process.stderr, "write").mockImplementation(flush as never);
      try {
        withJsonOutput(() => handlers.uncaughtException(new Error("JSON failure")));
        expect(JSON.parse(String(errorSpy.mock.calls.at(-1)?.[0])).error.message).toBe("JSON failure");
        expect(exitSpy).toHaveBeenLastCalledWith(1);
      } finally {
        stdout.mockRestore(); stderr.mockRestore();
      }
      expect(exitSpy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      onSpy.mockRestore();
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
