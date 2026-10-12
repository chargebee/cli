import type { Command } from "commander";
import { getOperation } from "@chargebee/code-sample-generator/node";

import { diagnostic, isJsonMode } from "../output.js";
import { LIST_NON_FILTER_KEYS, LIST_OPS_DOC_URL, assertSafeParameterKey, parseDataFlags } from "../codesample/index.js";
import { resolveCatalogVersion } from "./sdk.js";
import { bracketPath, buildParams, typeJsonScalars, type ParamEntry } from "./params.js";

export interface OperationParamOptions {
  method?: string;
  jsonInput?: boolean;
  opIdV1?: string;
  opIdV2?: string;
  pcVersionFlag?: string;
}

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
  opts: OperationParamOptions = {},
): Promise<Record<string, unknown>> {
  if (fromStdin && dataFlags.length > 0) {
    throw new StdinParamsError("error: pass parameters with '-' or with -d, not both.");
  }
  if (!fromStdin) {
    const params = parseDataFlags(dataFlags, opts);
    if (!opts.jsonInput || !dataFlags.length) return params;
    const pcVersion = opts.pcVersionFlag === "v1" || opts.pcVersionFlag === "v2"
      ? opts.pcVersionFlag
      : (await resolveCatalogVersion()) ?? "v2";
    const opId = pcVersion === "v1" ? opts.opIdV1 || opts.opIdV2 : opts.opIdV2 || opts.opIdV1;
    if (!opId) return params;
    const preferred = pcVersion === "v1" ? "v2-pcv1" : "v2-pcv2";
    const other = pcVersion === "v1" ? "v2-pcv2" : "v2-pcv1";
    return typeJsonScalars(params, (getOperation(preferred, opId) ?? getOperation(other, opId))?.params);
  }
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
  opts: OperationParamOptions = {},
): Promise<Record<string, unknown>> {
  try {
    return await resolveOperationParams(dataFlags, fromStdin, opts);
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
  const entries: ParamEntry[] = [];
  for (const [key, value] of Object.entries(params)) {
    try {
      assertSafeParameterKey(key);
    } catch {
      throw new StdinParamsError(`error: invalid parameter key '${key}'.`);
    }
    const path = bracketPath(key);
    if (!path) throw new StdinParamsError(`error: invalid parameter key '${key}'.`);
    entries.push({ key, path, value });
  }
  try {
    return buildParams(entries);
  } catch (error) {
    throw new StdinParamsError(`error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
