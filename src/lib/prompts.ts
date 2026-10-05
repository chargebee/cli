/**
 * Thin wrapper around `@clack/prompts`.
 *
 * Interactive prompts (text/password/confirm/select/multiselect) are wrapped so they
 * call `markInteractive()` the moment they run. The telemetry recorder uses that flag
 * to omit `dur_ms` for the invocation — otherwise the measured time would include
 * the user's typing/think-time at the prompt rather than real CLI work.
 *
 * IMPORTANT: interactive commands MUST import their prompts from this module (not from
 * `@clack/prompts` directly) so the interactive signal is set automatically. Non-input
 * helpers (`spinner`, `isCancel`, `cancel`, `intro`, `outro`, `note`) are passthroughs
 * and do NOT mark the run interactive (a spinner is progress UI, not user input).
 */
import * as clack from "@clack/prompts";

import { isJsonMode, OutputError } from "./output.js";
import { markInteractive } from "./telemetry/interactive.js";

// biome-ignore lint/suspicious/noExplicitAny: generic passthrough wrapper
type AnyFn = (...args: any[]) => any;

function interactive<T extends AnyFn>(fn: T): T {
  return ((...args: Parameters<T>): ReturnType<T> => {
    if (isJsonMode()) throw new OutputError("input_required", "Supply explicit command arguments in --json mode.");
    markInteractive();
    return fn(...args);
  }) as T;
}

/** TEST-ONLY: replace Clack impls so isolated CLI tests never wait on a TTY. */
export type PromptTestOverrides = {
  text?: AnyFn;
  password?: AnyFn;
  confirm?: AnyFn;
  select?: AnyFn;
  multiselect?: AnyFn;
  isCancel?: (value: unknown) => boolean;
  cancel?: AnyFn;
  spinner?: AnyFn;
  intro?: AnyFn;
  outro?: AnyFn;
  note?: AnyFn;
};

let overrides: PromptTestOverrides = {};

export function __setPromptsForTest(partial: PromptTestOverrides): void {
  overrides = { ...overrides, ...partial };
}

export function __resetPromptsForTest(): void {
  overrides = {};
}

function dispatch<T extends AnyFn>(name: keyof PromptTestOverrides, fallback: T): T {
  return ((...args: Parameters<T>): ReturnType<T> =>
    ((overrides[name] ?? fallback) as T)(...args)) as T;
}

/**
 * Whether an interactive prompt can actually be answered: both stdin and stdout
 * must be terminals. In CI, pipes and agent sandboxes Clack would otherwise
 * render the prompt and wait forever. Check this before any prompt whose
 * answer has a non-interactive equivalent (flags / env / positional arg).
 */
export function canPrompt(): boolean {
  return !isJsonMode() && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

// Interactive prompts — flag the run so telemetry omits dur_ms.
export const text: typeof clack.text = interactive(dispatch("text", clack.text));
export const password: typeof clack.password = interactive(dispatch("password", clack.password));
export const confirm: typeof clack.confirm = interactive(dispatch("confirm", clack.confirm));
export const select: typeof clack.select = interactive(dispatch("select", clack.select));
export const multiselect: typeof clack.multiselect = interactive(
  dispatch("multiselect", clack.multiselect),
);

// Non-input helpers — passthrough (do not mark the run interactive).
export const isCancel: typeof clack.isCancel = ((value: unknown) =>
  (overrides.isCancel ?? clack.isCancel)(value)) as typeof clack.isCancel;
export const cancel: typeof clack.cancel = dispatch("cancel", clack.cancel);
export const spinner: typeof clack.spinner = dispatch("spinner", clack.spinner);
export const intro: typeof clack.intro = dispatch("intro", clack.intro);
export const outro: typeof clack.outro = dispatch("outro", clack.outro);
export const note: typeof clack.note = dispatch("note", clack.note);
