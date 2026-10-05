/** Wraps `@chargebee/code-sample-generator`. */
import {
  generateCodeSample,
  getSupportedLanguages,
  ValidationError,
  type GenerateCodeSampleOptions,
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

/** Friendly name → default generator id. Versioned ids pass through unresolved. */
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

/** Extra names shown next to each canonical entry in `--code-sample list`. */
const LIST_ALIASES: Record<(typeof CANONICAL_LANGUAGES)[number], string[]> = {
  curl: [],
  python: ["python-v3", "python-v2"],
  nodejs: ["node", "javascript", "node-v3", "node-v2"],
  go: ["go-v4", "go-v3"],
  java: ["java-v4", "java-v3"],
  php: ["php-v4", "php-v3"],
  ruby: [],
  dotnet: ["csharp"],
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

/** `--code-sample list` body: canonical names, with aliases on the side. */
export function formatLanguageList(): string {
  const supported = new Set(getSupportedLanguages());
  const lines = ["Supported languages:"];
  for (const name of CANONICAL_LANGUAGES) {
    const aliases = LIST_ALIASES[name].filter((a) => {
      if (LANGUAGE_ALIASES[a] !== undefined) return true;
      return supported.has(a);
    });
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

/** Generate a code sample for a Chargebee API operation. */
export async function generate(opts: GenerateOptions): Promise<string> {
  const params = { ...(opts.params ?? {}) };
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

/**
 * Parse CLI -d key=value flags into a nested params object.
 * Handles bracket notation: "billing_address[line1]=value" → { billing_address: { line1: "value" } }
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
    const value = coerceValue(d.slice(eqIdx + 1));

    // Handle bracket notation
    const bracketIdx = key.indexOf("[");
    if (bracketIdx > 0) {
      const topKey = key.slice(0, bracketIdx);
      const subKey = key.slice(bracketIdx + 1, -1); // strip trailing ]

      if (!params[topKey] || typeof params[topKey] !== "object") {
        params[topKey] = {};
      }
      (params[topKey] as Record<string, unknown>)[subKey] = value;
    } else {
      params[key] = value;
    }
  }

  return params;
}
