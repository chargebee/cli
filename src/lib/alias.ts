import { existsSync, statSync } from "node:fs";
import { basename, dirname, join, win32 } from "node:path";

import { humanLog, jsonResult } from "./output.js";
import { userHome } from "./config/user-home.js";
import { paint } from "./ui/color.js";

export const DEFAULT_ALIAS_NAME = "cb";

const MARKER_COMMENT = "# chargebee-cli alias";

export type ShellId = "bash" | "zsh" | "fish" | "powershell";

export interface ShellTarget {
  shell: ShellId;
  file: string;
}

export interface SetAliasOptions {
  /** Add the alias even though a foreign alias with the same name already exists. */
  force?: boolean;
}

let platformOverride: NodeJS.Platform | null = null;

/** TEST-ONLY: pretend to run on another platform. Pass null to restore. */
export function __setPlatformForTest(value: NodeJS.Platform | null): void {
  platformOverride = value;
}

function platform(): NodeJS.Platform {
  return platformOverride ?? process.platform;
}

/**
 * Where (and in what shell's syntax) the alias would live, or null when the
 * running shell/platform isn't one we know how to write an alias for.
 */
export function detectShellTarget(): ShellTarget | null {
  const home = userHome();

  // A POSIX $SHELL wins even on Windows (Git Bash / MSYS set it); PowerShell
  // is the fallback there when $SHELL is unset or unknown.
  const name = basename(process.env.SHELL ?? "").toLowerCase();
  if (name === "zsh") return { shell: "zsh", file: join(home, ".zshrc") };
  if (name === "fish") {
    return { shell: "fish", file: join(home, ".config", "fish", "conf.d", "chargebee.fish") };
  }
  if (name === "bash") {
    const bashrc = join(home, ".bashrc");
    if (platform() !== "darwin" || existsSync(bashrc)) return { shell: "bash", file: bashrc };
    // macOS Terminal opens a login shell, which reads only the first existing
    // one of these, so write to that file rather than shadowing it with a new one.
    for (const candidate of [".bash_profile", ".bash_login", ".profile"]) {
      const file = join(home, candidate);
      if (existsSync(file)) return { shell: "bash", file };
    }
    return { shell: "bash", file: join(home, ".bash_profile") };
  }

  if (platform() === "win32") return { shell: "powershell", file: powershellProfile(home) };
  return null;
}

/**
 * The PowerShell profile to write. An explicit CHARGEBEE_CLI_POWERSHELL_PROFILE
 * (the installer passes the running shell's $PROFILE) wins; otherwise
 * PowerShell 7's profile when pwsh is on PATH or its profile dir already
 * exists, else Windows PowerShell 5's.
 */
function powershellProfile(home: string): string {
  const explicit = process.env.CHARGEBEE_CLI_POWERSHELL_PROFILE;
  if (explicit && win32.isAbsolute(explicit)) return explicit;
  const pwshDir = join(home, "Documents", "PowerShell");
  if (pwshOnPath() || existsSync(pwshDir)) {
    return join(pwshDir, "Microsoft.PowerShell_profile.ps1");
  }
  return join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
}

/**
 * Whether a `pwsh` executable (per PATHEXT) sits in any PATH entry; no process
 * is spawned. Extensions are matched lowercased, as the executable is named,
 * so the lookup behaves the same on case-sensitive filesystems.
 */
function pwshOnPath(): boolean {
  const exts = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
  for (const dir of (process.env.PATH ?? "").split(";").filter(Boolean)) {
    for (const ext of exts) {
      try {
        if (statSync(join(dir, `pwsh${ext.toLowerCase()}`)).isFile()) return true;
      } catch {
        // Not in this directory under this extension.
      }
    }
  }
  return false;
}

/** Whether `setAlias`/`removeAlias` know how to write an alias for the current shell. */
export function isAliasSupported(): boolean {
  return detectShellTarget() !== null;
}

function binaryPath(): string {
  const execName = basename(process.execPath).toLowerCase();
  if (execName.includes("node") || execName.includes("bun")) return "chargebee";
  return process.execPath;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function renderAliasLine(shell: ShellId, name: string, bin: string): string {
  switch (shell) {
    case "bash":
    case "zsh":
      return `alias ${name}=${shellQuote(bin)}  ${MARKER_COMMENT}`;
    case "fish":
      return `function ${name}; ${shellQuote(bin)} $argv; end  ${MARKER_COMMENT}`;
    case "powershell":
      return `Set-Alias ${name} ${powershellQuote(bin)}  ${MARKER_COMMENT}`;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether a line (owned or foreign) defines an alias/function named `name` for this shell. */
function definesName(shell: ShellId, trimmed: string, name: string): boolean {
  // Stop at the full name so `cb` does not match `cb-x`.
  const escaped = `${escapeRegExp(name)}(?![A-Za-z0-9_-])`;
  switch (shell) {
    case "bash":
    case "zsh":
      return trimmed.startsWith(`alias ${name}=`);
    case "fish":
      return (
        trimmed.startsWith(`alias ${name}=`) ||
        trimmed.startsWith(`alias ${name} `) ||
        new RegExp(`^function\\s+${escaped}`).test(trimmed)
      );
    case "powershell":
      return new RegExp(`^Set-Alias\\s+(-Name\\s+)?${escaped}`, "i").test(trimmed);
  }
}

function isOwnedLine(line: string): boolean {
  return line.includes(MARKER_COMMENT);
}

function manualInstructions(name: string): string {
  return `alias ${name}=${shellQuote(binaryPath())}`;
}

function printUnsupportedShell(name: string): void {
  jsonResult({ supported: false, instruction: manualInstructions(name) });
  humanLog("  Could not detect a supported shell (bash, zsh, fish, PowerShell).");
  humanLog(`  Add this to your shell's config yourself: ${manualInstructions(name)}`);
}

function sourceHint(shell: ShellId, file: string): string {
  if (shell === "powershell") return `. "${file}"  (or open a new PowerShell window)`;
  return `source ${file}  (or open a new terminal)`;
}

function detectEol(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * The file's content, or null when it does not exist. Any other read failure
 * (permissions, I/O) propagates so callers never mistake an unreadable file
 * for an empty one and overwrite it.
 */
async function readIfExists(file: string): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(file, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new Error(`Cannot read ${file}: ${(err as Error).message}`);
  }
}

/** Copy the pre-existing file to `<file>.chargebee-cli.bak`, once, before the first edit. */
async function backupOnce(file: string, content: string): Promise<void> {
  const backupPath = `${file}.chargebee-cli.bak`;
  if (existsSync(backupPath)) return;
  const { writeFile } = await import("node:fs/promises");
  await writeFile(backupPath, content, "utf-8");
}

/** Write via a temp file + rename in the same directory, preserving the original mode. */
async function atomicWrite(file: string, content: string): Promise<void> {
  const { chmod, mkdir, rename, stat, writeFile } = await import("node:fs/promises");
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.chargebee-cli.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, content, "utf-8");
  try {
    const { mode } = await stat(file);
    await chmod(tmp, mode & 0o777);
  } catch {
    // No pre-existing file to match the mode of.
  }
  await rename(tmp, file);
}

export function validateAliasName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(
      "Alias name may contain only letters, numbers, underscores, and hyphens.",
    );
  }
}

export async function setAlias(
  name: string = DEFAULT_ALIAS_NAME,
  options: SetAliasOptions = {},
): Promise<void> {
  validateAliasName(name);
  const target = detectShellTarget();
  if (!target) {
    printUnsupportedShell(name);
    return;
  }

  const { file, shell } = target;
  const line = renderAliasLine(shell, name, binaryPath());
  const content = await readIfExists(file);
  const eol = content !== null ? detectEol(content) : "\n";
  const lines = content !== null ? content.split(/\r\n|\n/) : [];

  const ownedIdx = lines.findIndex((l) => isOwnedLine(l) && definesName(shell, l.trim(), name));
  const foreignIdx = lines.findIndex(
    (l, i) => i !== ownedIdx && !isOwnedLine(l) && definesName(shell, l.trim(), name),
  );

  if (ownedIdx !== -1 && lines[ownedIdx].trim() === line.trim()) {
    jsonResult({ name, file, shell, changed: false });
    humanLog(`  Alias '${name}' already exists in ${file}`);
    return;
  }

  if (foreignIdx !== -1 && !options.force) {
    throw new Error(
      `  A different '${name}' is already defined in ${file}:\n` +
        `    ${lines[foreignIdx].trim()}\n` +
        `  Re-run with --force to add the Chargebee alias anyway.`,
    );
  }

  if (content !== null) await backupOnce(file, content);

  let nextContent: string;
  if (ownedIdx !== -1) {
    const next = [...lines];
    next[ownedIdx] = line;
    nextContent = next.join(eol);
  } else if (content) {
    const separator = content.endsWith(eol) ? "" : eol;
    nextContent = `${content}${separator}${line}${eol}`;
  } else {
    nextContent = `${line}${eol}`;
  }

  await atomicWrite(file, nextContent);
  jsonResult({ name, file, shell, changed: true });

  humanLog(`  ${paint("32", "✔")}  Added alias '${name}' to ${file}`);
  humanLog(`  Run: ${sourceHint(shell, file)}`);
}

export async function removeAlias(name: string = DEFAULT_ALIAS_NAME): Promise<void> {
  validateAliasName(name);
  const target = detectShellTarget();
  if (!target) {
    printUnsupportedShell(name);
    return;
  }

  const { file, shell } = target;
  const content = await readIfExists(file);
  if (content === null) {
    jsonResult({ name, file, shell, removed: false });
    humanLog(`  No alias '${name}' found — ${file} does not exist`);
    return;
  }

  const eol = detectEol(content);
  const lines = content.split(/\r\n|\n/);
  const kept = lines.filter((l) => !(isOwnedLine(l) && definesName(shell, l.trim(), name)));

  if (kept.length === lines.length) {
    jsonResult({ name, file, shell, removed: false });
    humanLog(`  No alias '${name}' found in ${file}`);
    return;
  }

  await backupOnce(file, content);
  await atomicWrite(file, kept.join(eol));
  jsonResult({ name, file, shell, removed: true });
  humanLog(`  ${paint("32", "✔")}  Removed alias '${name}' from ${file}`);
}

export async function showAlias(): Promise<void> {
  const target = detectShellTarget();
  if (!target) {
    printUnsupportedShell(DEFAULT_ALIAS_NAME);
    return;
  }

  const { file } = target;
  const content = await readIfExists(file);
  if (content === null) {
    jsonResult({ file, aliases: [] });
    humanLog("  No shell profile found");
    return;
  }

  const bin = binaryPath();
  let found = false;
  const aliases: string[] = [];

  for (const line of content.split(/\r\n|\n/)) {
    const trimmed = line.trim();
    const isAliasLike =
      trimmed.startsWith("alias ") || trimmed.startsWith("function ") || /^Set-Alias\s/i.test(trimmed);
    if (isAliasLike && trimmed.includes(bin)) {
      humanLog(`  ${trimmed} (in ${file})`);
      found = true;
      aliases.push(trimmed);
    }
  }

  jsonResult({ file, aliases });
  if (!found) {
    humanLog(`  No chargebee aliases found in ${file}`);
    humanLog("  Run: chargebee alias set");
  }
}
