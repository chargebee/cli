/** Build-time help metadata; no CLI execution or network access. */

import { sectionTitle } from "../lib/help-style.js";

export interface ArgumentHelp {
  name: string;
  description: string;
}

type SpecObject = Record<string, any>;

/** Keep examples intentionally small and stable; all values still come from the spec. */
export const EXAMPLE_OPERATIONS = new Set([
  "customer create", "customer list", "customer retrieve", "customer update",
  "subscription create-with-items", "subscription list", "subscription retrieve",
  "invoice list", "invoice retrieve", "item-family create", "item-family list",
  "item-family retrieve", "item create", "item list", "item retrieve",
  "item-price create", "item-price list", "item-price retrieve",
]);

/** Resolve local OpenAPI references, including parameter and schema references. */
function resolveRef(spec: SpecObject, value: SpecObject = {}): SpecObject {
  const seen = new Set<string>();
  while (typeof value.$ref === "string" && value.$ref.startsWith("#/") && !seen.has(value.$ref)) {
    seen.add(value.$ref);
    const target = value.$ref.slice(2).split("/").reduce(
      (node: any, key: string) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec,
    );
    if (!target || typeof target !== "object") return value;
    const { $ref, ...siblings } = value;
    value = { ...target, ...siblings };
  }
  return value;
}

/** Keep the first sentence, removing documentation markup and terminal controls. */
export function descriptionLine(value: unknown): string {
  if (typeof value !== "string") return "";
  const plain = value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*]/g, "")
    .replace(/(?<!\w)_|_(?!\w)/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.split(/(?<=[.!?])\s/)[0];
}

/** Use the actual path argument, even when it belongs to another resource. */
export function specArgument(
  spec: SpecObject, path: string, pathItem: SpecObject, operation: SpecObject,
): ArgumentHelp | undefined {
  const name = path.match(/\{([\w-]+)\}/)?.[1];
  if (!name) return undefined;
  // Operation-level parameters override shared path-level declarations.
  const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
    .map((parameter) => resolveRef(spec, parameter));
  const parameter = parameters.reverse().find((p) => p.in === "path" && p.name === name) ?? {};
  const parameterSchema = resolveRef(spec, parameter.schema);
  const resource = name.replace(/[-_]id$/, "");
  const schemaName = Object.keys(spec.components?.schemas ?? {}).find(
    (key) => key.replace(/[^a-z0-9]/gi, "").toLowerCase() === resource.replace(/[^a-z0-9]/gi, "").toLowerCase(),
  );
  const resourceSchema = resolveRef(spec, spec.components?.schemas?.[schemaName ?? ""]);
  const idSchema = resolveRef(spec, resourceSchema.properties?.id);
  const description = descriptionLine(parameter.description)
    || descriptionLine(parameterSchema.description)
    || descriptionLine(idSchema.description)
    || `${resource === "id" ? "Resource" : resource.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase())} identifier.`;
  return { name, description };
}

/** Reject schema behavior we do not validate, including unresolved and cyclic refs. */
function hasUnsupportedComposition(spec: SpecObject, rawSchema: SpecObject, stack = new Set<object>(), depth = 0): boolean {
  const schema = resolveRef(spec, rawSchema);
  if (!schema || typeof schema !== "object" || Object.hasOwn(schema, "$ref") || depth > 20 || stack.has(schema)) return true;
  const known = new Set([
    "type", "title", "description", "example", "examples", "default", "enum", "required", "properties", "items",
    "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "oneOf", "anyOf", "allOf", "not",
    "additionalProperties", "deprecated", "readOnly", "writeOnly", "nullable",
  ]);
  if (Object.keys(schema).some((key) => !known.has(key) && !key.startsWith("x-"))) return true;
  if (["oneOf", "anyOf", "allOf", "not"].some((key) => key in schema)) return true;
  if ((schema.type === "object" || schema.type === "array") && schema.enum !== undefined) return true;
  if (schema.format && !["email", "int32", "int64", "float", "double"].includes(schema.format)) return true;
  stack.add(schema);
  const children = [...Object.values(schema.properties ?? {}), ...(schema.items ? [schema.items] : [])];
  const unsupported = children.some((child) => hasUnsupportedComposition(spec, child as SpecObject, stack, depth + 1));
  stack.delete(schema);
  return unsupported;
}

function isSafeString(value: unknown): value is string {
  return typeof value === "string" && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

function validValue(spec: SpecObject, raw: unknown, rawSchema: SpecObject): boolean {
  const schema = resolveRef(spec, rawSchema);
  if (hasUnsupportedComposition(spec, schema) || raw === undefined || raw === null) return false;
  const type = schema.type;
  if (!["object", "array", "string", "integer", "number", "boolean"].includes(type)) return false;
  if (schema.enum && (!['string', 'integer', 'number', 'boolean'].includes(type) || !schema.enum.includes(raw))) return false;
  if (type === "object") {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const props = schema.properties ?? {};
    if (Object.keys(raw).some((key) => !(key in props))) return false;
    if ((schema.required ?? []).some((key: string) => !(key in raw))) return false;
    return Object.entries(raw).every(([key, value]) => validValue(spec, value, props[key]));
  }
  if (type === "array") return Array.isArray(raw) && raw.every((v) => validValue(spec, v, schema.items ?? {}));
  if (type === "string" && !isSafeString(raw)) return false;
  if (type === "integer" && !(typeof raw === "number" && Number.isInteger(raw))) return false;
  if (type === "number" && !(typeof raw === "number" && Number.isFinite(raw))) return false;
  if (type === "boolean" && typeof raw !== "boolean") return false;
  if (type && !["string", "integer", "number", "boolean"].includes(type)) return false;
  if (typeof raw === "string") {
    if (schema.minLength != null && raw.length < schema.minLength) return false;
    if (schema.maxLength != null && raw.length > schema.maxLength) return false;
    if (schema.pattern) {
      try { if (!new RegExp(schema.pattern).test(raw)) return false; }
      catch { return false; }
    }
    if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return false;
  }
  if (typeof raw === "number" && schema.format === "int32" && (raw < -2_147_483_648 || raw > 2_147_483_647)) return false;
  if (typeof raw === "number" && schema.format === "int64" && !Number.isSafeInteger(raw)) return false;
  if (typeof raw === "number") {
    if (schema.minimum != null && raw < schema.minimum) return false;
    if (schema.maximum != null && raw > schema.maximum) return false;
  }
  return true;
}

function concreteValue(spec: SpecObject, rawSchema: SpecObject): unknown {
  const schema = resolveRef(spec, rawSchema);
  if (hasUnsupportedComposition(spec, schema)) return undefined;
  for (const value of [schema.example, schema.default, ...(schema.enum ?? [])]) {
    if (validValue(spec, value, schema)) return value;
  }
  return undefined;
}

function requiredObject(spec: SpecObject, rawSchema: SpecObject, depth = 0): Record<string, unknown> | undefined {
  const schema = resolveRef(spec, rawSchema);
  if (depth > 20 || hasUnsupportedComposition(spec, schema) || schema.type !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const key of schema.required ?? []) {
    const prop = resolveRef(spec, schema.properties?.[key] ?? {});
    const value = concreteValue(spec, prop) ?? (prop.type === "object" ? requiredObject(spec, prop, depth + 1) : undefined);
    if (value === undefined || !validValue(spec, value, prop)) return undefined;
    out[key] = value;
  }
  return out;
}

function mediaSchema(spec: SpecObject, operation: SpecObject): { schema: SpecObject; example?: unknown; formEncoded: boolean } | undefined {
  const body = resolveRef(spec, operation.requestBody ?? {});
  if (Object.hasOwn(body, "$ref")) return undefined;
  const content = body.content ?? {};
  const rawMedia = content["application/x-www-form-urlencoded"] ?? content["application/json"] as SpecObject | undefined;
  if (!rawMedia) return undefined;
  const media = resolveRef(spec, rawMedia);
  if (Object.hasOwn(media, "$ref")) return undefined;
  let example = media.example;
  if (example === undefined && media.examples) {
    const first = Object.values(media.examples)[0] as SpecObject | undefined;
    example = resolveRef(spec, first ?? {}).value;
  }
  const schema = resolveRef(spec, media.schema ?? {});
  if (example === undefined) example = concreteValue(spec, schema);
  return { schema, example, formEncoded: content["application/x-www-form-urlencoded"] === rawMedia };
}

function hasObjectOfArrays(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (!Array.isArray(value)) {
    const values = Object.values(value);
    if (values.length > 0 && values.every(Array.isArray) && values.every((items) =>
      (items as unknown[]).every((item) => item === null || typeof item !== "object"))) return true;
    return values.some(hasObjectOfArrays);
  }
  return value.some(hasObjectOfArrays);
}

/** Derive shell arguments from the mapped spec operation, only for curated operations. */
export function specExample(
  spec: SpecObject, resource: string, operationName: string, path: string,
  pathItem: SpecObject, operation: SpecObject,
): string[] | undefined {
  if (!EXAMPLE_OPERATIONS.has(`${resource} ${operationName}`)) return undefined;
  const args: string[] = [];
  const placeholder = path.match(/\{([\w-]+)\}/)?.[1];
  if (placeholder) {
    const pathParams = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
      .map((p) => resolveRef(spec, p)).filter((p) => p.in === "path" && p.name === placeholder);
    const param = pathParams.at(-1) ?? {};
    if (Object.hasOwn(param, "$ref")) return undefined;
    const schema = resolveRef(spec, param.schema ?? {});
    const candidate = param.example ?? schema.example ?? schema.default;
    const value = candidate ?? placeholder;
    if (!validValue(spec, value, schema) || (typeof value === "string" && value.startsWith("-"))) return undefined;
    args.push(value === placeholder && candidate === undefined ? `<${placeholder}>` : String(value));
  }

  const mergedParams = new Map<string, SpecObject>();
  for (const param of [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map((p) => resolveRef(spec, p))) {
    if (param.in && param.name) mergedParams.set(`${param.in}:${param.name}`, param);
  }
  const params = [...mergedParams.values()].filter((p) => p.in === "query");
  if (params.some((param) => Object.hasOwn(param, "$ref"))) return undefined;
  const chosen: Record<string, unknown> = {};
  for (const param of params) {
    const schema = resolveRef(spec, param.schema ?? {});
    if (param.required) {
      const value = param.example ?? concreteValue(spec, schema);
      if (value === undefined || !validValue(spec, value, schema)) return undefined;
      chosen[param.name] = value;
    }
  }
  const optional = params.find((p) => {
    if (p.required) return false;
    const schema = resolveRef(spec, p.schema ?? {});
    const value = p.example ?? schema.example ?? schema.default;
    return value !== undefined && validValue(spec, value, schema) && ["string", "integer", "number", "boolean"].includes(schema.type);
  });
  if (optional) {
    const schema = resolveRef(spec, optional.schema ?? {});
    chosen[optional.name] = optional.example ?? schema.example ?? schema.default;
  }
  for (const [key, value] of Object.entries(chosen)) args.push("-d", `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);

  const hasBody = operation.requestBody !== undefined;
  if (hasBody) {
    const body = mediaSchema(spec, operation);
    if (!body) return undefined;
    let value = body.example;
    if (value === undefined) value = requiredObject(spec, body.schema);
    if (value === undefined || !validValue(spec, value, body.schema)) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) return undefined;
    if (body.formEncoded && hasObjectOfArrays(value)) return undefined;
    for (const [key, field] of Object.entries(value)) {
      const encoded = field !== null && typeof field === "object" ? JSON.stringify(field) : String(field);
      args.push("-d", `${key}=${encoded}`);
    }
    const schema = body.schema;
    if ((schema.required ?? []).some((key: string) => !Object.hasOwn(value, key))) return undefined;
  }
  return args.length ? args : undefined;
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9_./=@:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export function operationHelp(resource: string, operation: string, hasSample: boolean, args?: string[]): string {
  const command = `${resource} ${operation}`;
  const lines: string[] = [];
  if (args?.length && args.every(isSafeString)) {
    let example = `  chargebee ${command}`;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-d") example += ` \\\n    -d ${shellQuote(args[++i])}`;
      else example += ` ${shellQuote(args[i])}`;
    }
    lines.push("", sectionTitle("EXAMPLE"), example);
    if (hasSample) lines.push("", sectionTitle("GENERATE SDK CODE"), "  Add --code-sample python to the example above.");
  }
  lines.push("", sectionTitle("DOCUMENTATION"), `  chargebee docs ${command}`, "");
  return lines.join("\n");
}
