import type { Command } from "commander";

import { diagnostic, isJsonMode } from "../output.js";
import { LIST_NON_FILTER_KEYS, LIST_OPS_DOC_URL, assertSafeParameterKey, parseDataFlags } from "../codesample/index.js";

/** `-` reads one JSON object from stdin and uses it as the request params. */
export class StdinParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StdinParamsError";
  }
}

type CommandExit = Pick<Command, "error">;

function defaultStdinSource(): AsyncIterable<Buffer | string> {
  return process.stdin;
}

let stdinSource: () => AsyncIterable<Buffer | string> = defaultStdinSource;

/** Test hook. Pass null to restore reading process.stdin. */
export function __setStdinSource(source: (() => AsyncIterable<Buffer | string>) | null): void {
  stdinSource = source ?? defaultStdinSource;
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdinSource()) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Turn a JSON object into the params object the SDK form-encodes.
 * Bracket keys (`email[is]`, `customer[email][is]`) expand into nested objects
 * so they encode the same way as `-d`.
 */
export function parseStdinParams(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new StdinParamsError("error: stdin is empty. Pass a JSON object.");
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new StdinParamsError("error: stdin is not valid JSON.");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StdinParamsError("error: stdin must be a JSON object.");
  }

  return expandBracketKeys(value as Record<string, unknown>);
}

export async function resolveOperationParams(
  dataFlags: string[],
  fromStdin: boolean,
): Promise<Record<string, unknown>> {
  if (fromStdin && dataFlags.length > 0) {
    throw new StdinParamsError("error: pass parameters with '-' or with -d, not both.");
  }
  if (!fromStdin) return parseDataFlags(dataFlags);
  if (process.stdin.isTTY) {
    throw new StdinParamsError("error: '-' reads a JSON object from stdin, and stdin is a terminal.");
  }
  return parseStdinParams(await readStdinText());
}

export function readJsonMarker(token: string | undefined, command: CommandExit): boolean {
  try {
    if (token === undefined) return false;
    if (token === "-") return true;
    throw new StdinParamsError(
      `error: unexpected argument '${token}'. Pass '-' to read a JSON object from stdin.`,
    );
  } catch (e) {
    if (e instanceof StdinParamsError) command.error(e.message);
    throw e;
  }
}

export function takeResourceId(
  id: string | undefined,
  json: string | undefined,
  command: CommandExit,
): { id?: string; fromStdin: boolean } {
  try {
    if (id === "-") {
      throw new StdinParamsError(
        "error: '-' reads a JSON object from stdin. Pass the resource id before '-'.",
      );
    }
    if (json === undefined) return { id, fromStdin: false };
    if (json === "-") return { id, fromStdin: true };
    throw new StdinParamsError(
      `error: unexpected argument '${json}'. Pass '-' to read a JSON object from stdin.`,
    );
  } catch (e) {
    if (e instanceof StdinParamsError) command.error(e.message);
    throw e;
  }
}

export async function loadOperationParams(
  dataFlags: string[],
  fromStdin: boolean,
  command: CommandExit,
): Promise<Record<string, unknown>> {
  try {
    return await resolveOperationParams(dataFlags, fromStdin);
  } catch (e) {
    if (e instanceof StdinParamsError) command.error(e.message);
    throw e;
  }
}

/** Same bare-key note as `-d` list filters, for a JSON object. */
export function warnBareJsonFilters(
  params: Record<string, unknown>,
  resource: string,
  write: (msg: string) => void = (msg) => {
    if (isJsonMode()) diagnostic(msg);
    else process.stderr.write(msg);
  },
): void {
  for (const [key, value] of Object.entries(params)) {
    if (LIST_NON_FILTER_KEYS.has(key)) continue;
    if (value !== null && typeof value === "object") continue;
    write(
      `note: '${key}=${String(value)}' has no filter operator and is ignored by the List API.\n` +
        `Add an operator, e.g. '${key}[is]=${String(value)}' — also [in], [starts_with], [between], [gt]/[lt], [after]/[before] (dates).\n` +
        `See ${LIST_OPS_DOC_URL} or: chargebee docs ${resource} list\n`,
    );
  }
}

function expandBracketKeys(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    try {
      assertSafeParameterKey(key);
    } catch {
      throw new StdinParamsError(`error: invalid parameter key '${key}'.`);
    }
    if (!key.includes("[")) {
      if (Object.prototype.hasOwnProperty.call(out, key)) {
        throw new StdinParamsError(`error: conflicting parameter '${key}'.`);
      }
      out[key] = value;
      continue;
    }
    const parts = bracketParts(key);
    if (!parts) throw new StdinParamsError(`error: invalid parameter key '${key}'.`);
    assignPath(out, parts, value);
  }
  return out;
}

function formatPath(parts: string[]): string {
  return parts[0] + parts.slice(1).map((part) => `[${part}]`).join("");
}

function bracketParts(key: string): string[] | null {
  const open = key.indexOf("[");
  if (open <= 0) return null;
  const rest = key.slice(open);
  if (!/^(?:\[[^\[\]]+\])+$/.test(rest)) return null;
  const parts = [key.slice(0, open)];
  for (const match of rest.matchAll(/\[([^\[\]]+)\]/g)) {
    parts.push(match[1]);
  }
  return parts;
}

function assignPath(root: Record<string, unknown>, parts: string[], value: unknown): void {
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = Object.hasOwn(cursor, part) ? cursor[part] : undefined;
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      cursor[part] = created;
      cursor = created;
      continue;
    }
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      throw new StdinParamsError(`error: conflicting parameter '${formatPath(parts.slice(0, i + 1))}'.`);
    }
    cursor = next as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (Object.prototype.hasOwnProperty.call(cursor, leaf)) {
    throw new StdinParamsError(`error: conflicting parameter '${formatPath(parts)}'.`);
  }
  cursor[leaf] = value;
}
