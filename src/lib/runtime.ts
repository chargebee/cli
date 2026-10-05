/**
 * How this process was started: a compiled standalone binary (`execPath` IS
 * the CLI) or a JavaScript runtime running an entry script. Shared by the
 * self-updater (which must only ever overwrite the compiled binary) and the
 * telemetry flush child (which must re-launch the CLI the same way).
 */
import { realpathSync } from "node:fs";

/** Bun's virtual entry path inside a compiled binary (`/$bunfs/root/...`, `B:\~BUN\root\...`). */
export const BUN_VIRTUAL_ENTRY = /^(\/\$bunfs\/|[A-Za-z]:\\~BUN\\)/;

/** The parts of `process` the detection reads; injectable so tests can describe other launch shapes. */
export type ProcessShape = Pick<NodeJS.Process, "execPath" | "argv">;

/**
 * The real path of the entry script a runtime is executing, or `null` when
 * `execPath` is the CLI itself (a compiled binary):
 *  - compiled binary: `argv[1]` is Bun's virtual entry (never resolvable on
 *    disk), or equals `execPath` (Node single-executable), or is absent.
 *  - npm install under Node: `argv[1]` is the extensionless bin *symlink*
 *    (`/usr/local/bin/chargebee`); it resolves to the real `dist/index.js`.
 *  - dev (`bun src/index.ts`): `argv[1]` is the script itself.
 * The runtime's own file name is never consulted, so `nodejs`, `node22`, an
 * nvm shim, or any other renamed runtime is still recognised as a runtime as
 * long as the script it runs exists on disk.
 */
export function resolveEntryScript(proc: ProcessShape = process): string | null {
  const entry = proc.argv[1];
  if (!entry || BUN_VIRTUAL_ENTRY.test(entry)) return null;
  let script: string;
  try {
    script = realpathSync(entry);
  } catch {
    return null;
  }
  let exe = proc.execPath;
  try {
    exe = realpathSync(exe);
  } catch {
    // keep as-is
  }
  return script === exe ? null : script;
}

/** True when running from a compiled standalone binary, i.e. {@link resolveEntryScript} finds no entry script. */
export function isCompiledBinary(proc: ProcessShape = process): boolean {
  return resolveEntryScript(proc) === null;
}
