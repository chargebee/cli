/** Wraps `@chargebee/code-sample-generator`. */
import {
  generateCodeSample,
  getOperation,
  getSupportedLanguages,
  ValidationError,
  type GenerateCodeSampleOptions,
  type MinimalOperationDescriptor,
} from "@chargebee/code-sample-generator/node";

import { diagnostic, isJsonMode } from "../output.js";
import { PRODUCTION_SUFFIX, rewriteApiHostInText, type ApiHost } from "../config/host.js";

/**
 * Names we advertise in `--help`, `--code-sample list`, README, and the skill.
 * Versioned generator IDs (`python-v3`, `node-v2`, …) are still accepted as input.
 */
export const CANONICAL_LANGUAGES = [
  "curl",
  "python",
  "nodejs",
  "go",
  "java",
  "php",
  "ruby",
  "dotnet",
] as const;

export const CODE_SAMPLE_OPTION_HELP =
  "Generate code sample (curl, python, nodejs, go, ruby, java, php, dotnet, list)";

/** CLI names and pinned defaults; the generator exports IDs but no alias/default map. */
const LANGUAGE_ALIASES: Record<string, string> = {
  nodejs: "node-v3",
  node: "node-v3",
  javascript: "node-v3",
  python: "python-v3",
  java: "java-v4",
  php: "php-v4",
  dotnet: "dotnet",
  csharp: "dotnet",
  ruby: "ruby",
  go: "go-v4",
  curl: "curl",
};

/** Resolves a user-provided language name to a generator language ID. */
export function resolveLanguage(input: string): string {
  const lower = input.toLowerCase();
  return LANGUAGE_ALIASES[lower] ?? lower;
}

/** True when `input` is a canonical name, alias, or a generator language ID. */
export function isSupportedLanguage(input: string): boolean {
  return getSupportedLanguages().includes(resolveLanguage(input));
}

/** `--code-sample list` body: CLI names plus versions supported by the generator. */
export function formatLanguageList(): string {
  const supported = new Set(getSupportedLanguages());
  const lines = ["Supported languages:"];
  for (const name of CANONICAL_LANGUAGES) {
    const defaultId = LANGUAGE_ALIASES[name];
    const family = defaultId.replace(/-v\d+$/, "");
    const friendly = Object.keys(LANGUAGE_ALIASES).filter(
      (alias) => alias !== name && LANGUAGE_ALIASES[alias] === defaultId,
    );
    const generatorIds = [...supported]
      .filter((id) => id !== name && (id === family || id.startsWith(`${family}-v`)))
      .sort((a, b) => a === defaultId ? -1 : b === defaultId ? 1 : b.localeCompare(a, undefined, { numeric: true }));
    const aliases = [...new Set([...friendly, ...generatorIds])]
      .filter((alias) => supported.has(resolveLanguage(alias)));
    if (aliases.length > 0) {
      lines.push(`  ${name.padEnd(10)} aliases: ${aliases.join(", ")}`);
    } else {
      lines.push(`  ${name}`);
    }
  }
  return lines.join("\n");
}

export interface GenerateOptions {
  operationId: string;
  language: string;
  params?: Record<string, unknown>;
  resourceId?: string;
  pathParamName?: string;
  site?: string;
  apiVersion?: string;
  pcVersion?: string;
  method?: string;
  uri?: string;
  hostSuffix?: string;
  protocol?: "https" | "http";
}

/**
 * Group indexed form values by field for code-sample generation. Chargebee
 * represents an array of objects as field-first keys such as
 * subscription_items[item_price_id][0], while the generator validates and
 * renders those values from field arrays such as
 * { subscription_items: { item_price_id: ["basic-USD"] } }.
 * Accept the shapes produced by -d and JSON stdin, then give the generator
 * one consistent form so it can check field names and required values.
 */
function codeSampleFormParams(
  params: Record<string, unknown>,
  descriptor: MinimalOperationDescriptor | undefined,
): Record<string, unknown> {
  const normalized = { ...params };
  const setIndexed = (fields: Record<string, unknown>, field: string, rawIndex: string, value: unknown) => {
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index) || index > 10_000) {
      throw new Error(`Invalid indexed parameter ${field}[${rawIndex}].`);
    }
    const items = Array.isArray(fields[field]) ? fields[field] as unknown[] : [];
    items[index] = value;
    fields[field] = items;
  };
  for (const [name, value] of Object.entries(params)) {
    const fieldSchema = descriptor?.params?.[name];
    if (fieldSchema?.t !== "obj" || !fieldSchema.p ||
        !Object.values(fieldSchema.p).some((field) => field.t === "arr")) continue;
    if (Array.isArray(value)) {
      if (!value.every((item) => item && typeof item === "object" && !Array.isArray(item))) continue;
      const fields: Record<string, unknown> = Object.create(null);
      value.forEach((item, index) => {
        for (const [field, fieldValue] of Object.entries(item)) {
          setIndexed(fields, field, String(index), fieldValue);
        }
      });
      normalized[name] = fields;
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const fields = Object.entries(value);
    const hasIndexedField = fields.some(([, fieldValue]) =>
      fieldValue !== null && typeof fieldValue === "object" && !Array.isArray(fieldValue) &&
        Object.keys(fieldValue).some((index) => /^\d+$/.test(index)),
    );
    if (!hasIndexedField) continue;
    const grouped: Record<string, unknown> = Object.create(null);
    for (const [field, fieldValue] of fields) {
      if (fieldValue !== null && typeof fieldValue === "object" && !Array.isArray(fieldValue) &&
          Object.keys(fieldValue).length > 0 && Object.keys(fieldValue).every((index) => /^\d+$/.test(index))) {
        for (const [index, indexedValue] of Object.entries(fieldValue)) {
          setIndexed(grouped, field, index, indexedValue);
        }
      } else {
        grouped[field] = fieldValue;
      }
    }
    normalized[name] = grouped;
  }
  return normalized;
}

/** Generate a code sample for a Chargebee API operation. */
export async function generate(opts: GenerateOptions): Promise<string> {
  const version = opts.apiVersion === "v1" ? "v1" : opts.pcVersion === "v1" ? "v2-pcv1" : "v2-pcv2";
  const descriptor = getOperation(version, opts.operationId);
  const isJsonInput = descriptor?.flags?.json === true;
  const params = isJsonInput
    ? { ...(opts.params ?? {}) }
    : codeSampleFormParams(opts.params ?? {}, descriptor);
  if (opts.resourceId !== undefined && opts.pathParamName) {
    params[opts.pathParamName] = opts.resourceId;
  }

  const options = {
    operation: opts.operationId,
    language: resolveLanguage(opts.language),
    apiVersion: opts.apiVersion ?? "v2",
    pcVersion: opts.pcVersion ?? "v2",
    site: opts.site ?? "your-site",
    apiKey: "test_api_key",
    request: {
      uri: opts.uri ?? "",
      method: opts.method ?? "POST",
      params,
    },
    // Check the request shape using the bundled operation schema. CLI scalar
    // values remain strings, so leave value validation to the API.
    validate: {
      // Catch misspelled parameter names; cf_ custom fields are handled below.
      allowUnknown: false,
      validateRequired: true,
      // CLI scalars stay strings (e.g. "true"), which strict type checks reject.
      validateTypes: false,
      // Limit local checks to names and required fields; the API validates enum values.
      validateEnums: false,
    },
  } as GenerateCodeSampleOptions;

  let result;
  try {
    result = await generateCodeSample(options);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    // Site-specific custom fields cannot appear in the bundled public schema.
    // Suppress only those unknown-field issues; keep every other validation
    // failure, including typos alongside a custom field.
    const issues = error.issues.filter(
      (issue) => !(issue.code === "unknown_field" && issue.path.split(".").at(-1)?.startsWith("cf_")),
    );
    if (issues.length > 0) throw new ValidationError(error.operation, issues);
    result = await generateCodeSample({ ...options, validate: false });
  }

  const site = opts.site ?? "your-site";
  const host: ApiHost = {
    suffix: opts.hostSuffix ?? PRODUCTION_SUFFIX,
    protocol: opts.protocol ?? "https",
    isProduction: (opts.hostSuffix ?? PRODUCTION_SUFFIX) === PRODUCTION_SUFFIX,
  };
  return rewriteApiHostInText(result.code, site, host);
}

/**
 * Coerce a raw CLI value into the shape the Chargebee SDK expects.
 *
 * Values that look like JSON arrays/objects (`[...]` / `{...}`) are parsed into
 * real JS values; everything else stays a string. This matters for list filter
 * operators (`[in]`, `[not_in]`, `[between]`): the SDK's serializer JSON-encodes
 * those values, so passing a JSON *string* would double-encode it (producing
 * `id[in]="[\"a\"]"` and a `wrong format` API error). Parsing to a real array
 * makes the SDK emit the correct `id[in]=["a"]`.
 *
 * Parsing is best-effort: malformed JSON falls back to the raw string so a value
 * that merely starts with `[`/`{` can never throw.
 */
function coerceValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * List-API query params that are not filters and do not take an operator suffix.
 * Everything else on a list call is a Chargebee filter and needs `[is]`, `[in]`, etc.
 */
export const LIST_NON_FILTER_KEYS = new Set(["limit", "offset", "include_deleted"]);

/** Canonical docs for list filter operators (all resources). */
export const LIST_OPS_DOC_URL = "https://apidocs.chargebee.com/docs/api/list-ops";

/**
 * Warn on stderr when a list `-d` key looks like a filter but has no operator.
 * Does not change the parsed params — callers still send what the user typed.
 */
export function warnBareListFilters(
  dataFlags: string[],
  resource: string,
  write: (msg: string) => void = (msg) => {
    if (isJsonMode()) diagnostic(msg);
    else process.stderr.write(msg);
  },
): void {
  for (const d of dataFlags) {
    const eqIdx = d.indexOf("=");
    if (eqIdx === -1) continue;
    const key = d.slice(0, eqIdx);
    assertSafeParameterKey(key);
    if (key.includes("[")) continue;
    if (LIST_NON_FILTER_KEYS.has(key)) continue;
    const value = d.slice(eqIdx + 1);
    write(
      `note: '${key}=${value}' has no filter operator and is ignored by the List API.\n` +
        `Add an operator, e.g. '${key}[is]=${value}' — also [in], [starts_with], [between], [gt]/[lt], [after]/[before] (dates).\n` +
        `See ${LIST_OPS_DOC_URL} or: chargebee docs ${resource} list\n`,
    );
  }
}

/** Reject path segments that could traverse or replace object prototypes. */
export function assertSafeParameterKey(key: string): void {
  if (key.split(/[\[\]]/).some((part) => ["__proto__", "constructor", "prototype"].includes(part))) {
    throw new Error(`Invalid parameter key ${JSON.stringify(key)}.`);
  }
}

/**
 * Parse CLI -d key=value flags into a nested params object.
 * Handles bracket notation: "billing_address[line1]=value" → { billing_address: { line1: "value" } }
 * Indexed item fields become arrays of objects: "items[id][0]=value" → { items: [{ id: "value" }] }.
 * JSON-looking values are parsed so list filters like `id[in]=["a","b"]` encode correctly.
 */
export function parseDataFlags(
  dataFlags: string[]
): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  for (const d of dataFlags) {
    const eqIdx = d.indexOf("=");
    if (eqIdx <= 0 || !d.slice(0, eqIdx).trim()) {
      throw new Error(
        `Invalid data parameter ${JSON.stringify(d)}. Expected a non-empty key=value pair.\n` +
          "Example: -d email=ada@example.com",
      );
    }

    const key = d.slice(0, eqIdx);
    assertSafeParameterKey(key);
    const value = coerceValue(d.slice(eqIdx + 1));

    const indexedField = /^([^\[\]]+)\[([^\[\]]+)\]\[(\d+)\]$/.exec(key);
    if (indexedField) {
      const [, topKey, field, rawIndex] = indexedField;
      const index = Number(rawIndex);
      if (!Number.isSafeInteger(index) || index > 10_000) {
        throw new Error(`Invalid indexed parameter ${JSON.stringify(key)}.`);
      }
      if (!Array.isArray(params[topKey])) params[topKey] = [];
      const items = params[topKey] as Record<string, unknown>[];
      if (!items[index]) items[index] = {};
      items[index][field] = value;
      continue;
    }

    // Handle bracket notation
    const bracketIdx = key.indexOf("[");
    if (bracketIdx > 0) {
      const topKey = key.slice(0, bracketIdx);
      const subKey = key.slice(bracketIdx + 1, -1); // strip trailing ]

      if (!Object.hasOwn(params, topKey) || !params[topKey] || typeof params[topKey] !== "object") {
        params[topKey] = {};
      }
      (params[topKey] as Record<string, unknown>)[subKey] = value;
    } else {
      params[key] = value;
    }
  }

  return params;
}
