import { AsyncLocalStorage } from "node:async_hooks";
import { stripVTControlCharacters } from "node:util";

interface OutputState {
  result?: unknown;
  diagnostics: string[];
  completed: boolean;
  streaming: boolean;
}

const invocation = new AsyncLocalStorage<OutputState>();

/** Each parse owns its output state, including asynchronous command callbacks. */
export function withJsonOutput<T>(fn: () => T): T {
  return invocation.run({ diagnostics: [], completed: false, streaming: false }, fn);
}

export function isJsonMode(): boolean {
  return invocation.getStore() !== undefined;
}

export function outputCompleted(): boolean {
  return invocation.getStore()?.completed === true;
}

/** Human progress/formatting is deliberately absent from machine output. */
export function humanLog(...args: unknown[]): void {
  if (!isJsonMode()) console.log(...args);
}

export function diagnostic(...args: unknown[]): void {
  const state = invocation.getStore();
  if (!state) {
    console.error(...args);
    return;
  }
  state.diagnostics.push(stripVTControlCharacters(args.map(String).join(" ")).trim());
}

/** Set the command's result; emit only once the command has completed successfully. */
export function jsonResult(value: unknown): boolean {
  const state = invocation.getStore();
  if (!state) return false;
  state.result = value ?? null;
  return true;
}

export function printJson(value: unknown): void {
  if (!jsonResult(value)) console.log(JSON.stringify(value, null, 2));
}

/** A listener is an unbounded stream of metadata records, never webhook bodies. */
export function streamRecord(type: string, fields: Record<string, unknown> = {}, error = false): boolean {
  const state = invocation.getStore();
  if (!state) return false;
  if (state.completed) return true;
  state.streaming = true;
  const line = JSON.stringify({ type, timestamp: new Date().toISOString(), ...fields });
  if (error) console.error(line);
  else console.log(line);
  return true;
}

export function finishOutput(exitCode = 0, code = "command_failed", details?: unknown): void {
  const state = invocation.getStore();
  if (!state || state.completed) return;
  state.completed = true;
  if (exitCode !== 0) {
    console.error(JSON.stringify({ error: {
      code,
      message: state.diagnostics.filter(Boolean).join("\n") || "Command failed.",
      exit_code: exitCode,
      ...(details === undefined ? {} : { details }),
    } }));
    return;
  }
  if (!state.streaming) console.log(JSON.stringify(state.result === undefined ? { success: true } : state.result));
  if (state.diagnostics.length) console.error(JSON.stringify({ warnings: state.diagnostics }));
}

/** Preserve existing exit codes while flushing the structured outcome first. */
export function exitCommand(code: number, errorCode?: string): never {
  finishOutput(code, errorCode);
  // Let the entry point return normally so Node can flush piped JSON in full.
  if (isJsonMode()) throw new OutputExit(code);
  process.exit(code);
}

export class OutputExit extends Error {
  constructor(public readonly exitCode: number) {
    super(`Command exited with code ${exitCode}`);
  }
}

/** Fatal errors and listener deadlines still terminate after pending output drains. */
export function exitAfterOutput(code: number): void {
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}

export class OutputError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}
