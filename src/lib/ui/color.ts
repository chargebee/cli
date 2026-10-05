/**
 * Shared ANSI-color gate for stdout output (`auth add`/`alias`/`update`
 * messages, the write/catalog gate errors), following the no-color.org
 * convention: https://no-color.org/
 */

export interface ColorGate {
  stdoutIsTTY?: boolean;
  env?: NodeJS.Dict<string | undefined>;
}

/**
 * Whether ANSI color codes may be emitted on stdout. `NO_COLOR` (set to any
 * value, per https://no-color.org/) wins outright and disables color, even
 * over `FORCE_COLOR`. Otherwise `FORCE_COLOR=0` disables color and any other
 * `FORCE_COLOR` value enables it (even without a TTY). Otherwise color
 * follows whether stdout is a TTY, with `TERM=dumb` disabling it.
 */
export function colorEnabled(opts: ColorGate = {}): boolean {
  const env = opts.env ?? process.env;

  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR === "0") return false;
  if (env.FORCE_COLOR !== undefined) return true;
  if (env.TERM === "dumb") return false;

  return opts.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
}

/** Wrap `text` in ANSI SGR `code` (e.g. "32" for green, "31" for red) when color is enabled, else return it unchanged. */
export function paint(code: string, text: string, opts: ColorGate = {}): string {
  if (!colorEnabled(opts)) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}
