/** The SDK's form encoder sends these filter arrays as one JSON value. */
import type { MinimalParamInfo } from "@chargebee/code-sample-generator/node";

const ARRAY_OPERATORS = new Set(["in", "not_in", "between"]);
const MAX_INDEX = 10_000;

export interface ParamEntry {
  key: string;
  path: string[];
  value: unknown;
}

/** Reject keys that could change an object's prototype. */
export function assertSafeParameterKey(key: string): void {
  if (key.split(/[\[\]]/).some((part) => ["__proto__", "constructor", "prototype"].includes(part))) {
    throw new Error(`Invalid parameter key ${JSON.stringify(key)}.`);
  }
}

/** Parse `a[b][0]` into path segments, rejecting partial or empty brackets. */
export function bracketPath(key: string): string[] | null {
  const match = /^([^\[\]]+)((?:\[[^\[\]]+\])*)$/.exec(key);
  if (!match) return null;
  const parts = [match[1], ...[...match[2].matchAll(/\[([^\[\]]+)\]/g)].map((m) => m[1])];
  try {
    for (const part of parts) assertSafeParameterKey(part);
  } catch {
    return null;
  }
  return parts;
}

function indexOf(part: string, key: string): number | null {
  if (!/^\d+$/.test(part)) return null;
  const index = Number(part);
  if (!Number.isSafeInteger(index) || index > MAX_INDEX) {
    throw new Error(`Invalid indexed parameter ${JSON.stringify(key)}.`);
  }
  return index;
}

function pathLabel(parts: string[]): string {
  return parts[0] + parts.slice(1).map((part) => `[${part}]`).join("");
}

function conflict(path: string, first: string, second: string): Error {
  return new Error(`conflicting parameter '${path}' (${JSON.stringify(first)} and ${JSON.stringify(second)}).`);
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

/** Build a single canonical nested object for both CLI input forms. */
export function buildParams(entries: ParamEntry[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const owners = new Map<string, string>();
  const fieldFirstArrays = new WeakSet<unknown[]>();

  for (const entry of entries) {
    const { key, value } = entry;
    const parts = entry.path;
    if (!parts.length || parts.some((part) => !part)) throw new Error(`Invalid parameter key ${JSON.stringify(key)}.`);
    // Chargebee's form format indexes an array of objects by field first.
    const fieldFirst = parts.length === 3 && indexOf(parts[1], key) === null && indexOf(parts[2], key) !== null;
    const route = fieldFirst ? [parts[0], parts[2], parts[1]] : parts;
    let cursor: Record<string, unknown> | unknown[] = root;

    for (let i = 0; i < route.length; i++) {
      const segment = route[i];
      const index = indexOf(segment, key);
      if (Array.isArray(cursor) !== (index !== null)) {
        const path = pathLabel(parts.slice(0, i));
        throw conflict(path, owners.get(path) ?? key, key);
      }
      const property: string | number = index ?? segment;
      const exists = Object.hasOwn(cursor, property);
      const current: unknown = (cursor as Record<string | number, unknown>)[property];
      if (i === route.length - 1) {
        if (exists) {
          const path = pathLabel(parts);
          throw conflict(path, owners.get(path) ?? key, key);
        }
        (cursor as Record<string | number, unknown>)[property] = value;
        owners.set(pathLabel(parts), key);
        continue;
      }
      const nextIsArray = indexOf(route[i + 1], key) !== null;
      if (!exists) {
        const created: Record<string, unknown> | unknown[] = nextIsArray ? [] : {};
        if (fieldFirst && i === 0 && Array.isArray(created)) fieldFirstArrays.add(created);
        (cursor as Record<string | number, unknown>)[property] = created;
        owners.set(pathLabel(parts.slice(0, i + 1)), key);
        cursor = created;
      } else {
        if (!isContainer(current) || Array.isArray(current) !== nextIsArray) {
          const path = pathLabel(parts.slice(0, i + 1));
          throw conflict(path, owners.get(path) ?? key, key);
        }
        cursor = current;
      }
    }
  }

  const checkGaps = (value: unknown, path: string): void => {
    if (!isContainer(value)) return;
    if (Array.isArray(value) && !fieldFirstArrays.has(value)) {
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(value, i)) throw new Error(`Missing indexed parameter ${path}[${i}].`);
      }
    }
    for (const [key, child] of Object.entries(value)) checkGaps(child, path ? `${path}[${key}]` : key);
  };
  checkGaps(root, "");
  return root;
}

/** Coerce only schema-declared scalar types for JSON-body operations. */
export function typeJsonScalars(
  params: Record<string, unknown>,
  schema: Record<string, MinimalParamInfo> | undefined,
): Record<string, unknown> {
  if (!schema) return params;
  const visit = (value: unknown, info: MinimalParamInfo | undefined): unknown => {
    if (!info) return value;
    if (typeof value === "string") {
      if (info.t === "bool" && (value === "true" || value === "false")) return value === "true";
      if ((info.t === "int" || info.t === "long" || info.t === "num") && /^-?\d+(?:\.\d+)?$/.test(value)) {
        const number = Number(value);
        if (Number.isFinite(number) && (value.includes(".") || Number.isSafeInteger(number))) return number;
      }
      return value;
    }
    if (Array.isArray(value) && info.t === "arr") return value.map((item) => visit(item, info.i));
    if (value && typeof value === "object" && info.t === "obj") {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child, info.p?.[key])]));
    }
    return value;
  };
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, visit(value, schema[key])]));
}

/** Flatten only GET params to avoid the pinned SDK's sibling-key serializer bug. */
export function toSdkParams(params: Record<string, unknown>, method: string, isList = false): Record<string, unknown> {
  if (method.toUpperCase() !== "GET") return params;
  const out: Record<string, unknown> = {};
  const visit = (path: string, value: unknown): void => {
    if (Array.isArray(value)) {
      const last = path.slice(path.lastIndexOf("[") + 1).replace(/\]$/, "");
      if (ARRAY_OPERATORS.has(last) || (isList && !path.includes("["))) {
        out[path] = JSON.stringify(value);
      } else {
        value.forEach((item, i) => visit(`${path}[${i}]`, item));
      }
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(`${path}[${key}]`, child);
    } else {
      out[path] = value;
    }
  };
  for (const [key, value] of Object.entries(params)) visit(key, value);
  return out;
}
