#!/usr/bin/env bun
/**
 * Code generator: reads the Chargebee Node.js SDK's endpoint registry and the
 * public OpenAPI specs, then generates TypeScript command files using Commander.
 *
 * Source:
 *   - chargebee SDK's api_endpoints.ts (resources + operations)
 *   - public OpenAPI specs (operationIds for code-sample generation):
 *       v2 PC2: chargebee_api_v2_pc_v2_spec.json
 *       v2 PC1: chargebee_api_v2_pc_v1_spec.json
 * Output: src/commands/generated/ (one file per resource + registry.ts)
 *
 * Usage:
 *   bun run src/tools/generate.ts [options]
 *
 * Options:
 *   --out <dir>            Output directory (default: src/commands/generated)
 *   --spec-url-v2 <url>    Override the PC2 OpenAPI spec URL
 *   --spec-url-v1 <url>    Override the PC1 OpenAPI spec URL
 *   --spec-file-v2 <path>  Use a local PC2 spec file instead of fetching
 *   --spec-file-v1 <path>  Use a local PC1 spec file instead of fetching
 *   --offline              Use cached specs only; fail if cache is missing
 *   --refresh              Force re-fetch even if a cached copy exists
 *   --strict               Accepted for backwards compatibility; no longer gates on
 *                          missing operationIds (an empty id is a spec fact, not a
 *                          generator failure). Real problems (spec fetch failure,
 *                          catalog-assertion mismatches) always fail regardless.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { auditOperationIds } from "./audit-operation-ids.js";
import { sectionTitle } from "../lib/help-style.js";
import { specArgument, specExample, operationHelp, type ArgumentHelp } from "./command-help.js";
import { isReadOnlyOperation } from "../lib/api/write-gate.js";

const { Endpoints } = await import(
  join(process.cwd(), "node_modules/chargebee/esm/resources/api_endpoints.js")
);

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function has(name: string): boolean {
  return args.includes(name);
}

const outDir = resolve(flag("--out") ?? "src/commands/generated");
const cacheDir = resolve(".cache/specs");

const SPEC_V2_URL =
  flag("--spec-url-v2") ??
  "https://raw.githubusercontent.com/chargebee/openapi/refs/heads/main/spec/chargebee_api_v2_pc_v2_spec.json";
const SPEC_V1_URL =
  flag("--spec-url-v1") ??
  "https://raw.githubusercontent.com/chargebee/openapi/refs/heads/main/spec/chargebee_api_v2_pc_v1_spec.json";

const SPEC_FETCH_TIMEOUT_MS = 120_000;

type CatalogTag = "pc1" | "pc2" | "both";

interface Operation {
  sdkAction: string;
  cliCommand: string;
  method: string;
  hasId: boolean;
  urlPrefix: string;
  urlSuffix: string;
  operationIdV2: string;
  operationIdV1: string;
  /** Catalog this operation is exclusive to, or "both"/unknown (never filtered). */
  catalog: CatalogTag;
  /** Human-readable summary resolved from the spec (v2 precedence), or a fallback. */
  summary: string;
  argument?: ArgumentHelp;
  example?: string[];
}

interface Resource {
  sdkName: string;
  cliName: string;
  snakeName: string;
  humanName: string;
  operations: Operation[];
}

/**
 * Escape hatch: operation keys (`sdkName.sdkAction`) to force-classify as "both"
 * (never gated), in case a genuine public-spec gap ever mis-tags a cross-catalog
 * operation as exclusive. Normally empty — catalog membership is derived per
 * operation directly from the specs.
 */
const FORCE_BOTH = new Set<string>([]);

/**
 * Sanity assertions: core operations whose catalog must classify as expected.
 * A mismatch fails generation loudly so a spec change can't silently mis-gate the
 * catalog-defining operations. Keyed by `sdkName.sdkAction`.
 */
const CATALOG_OP_ASSERTIONS: Record<string, "pc1" | "pc2"> = {
  "plan.list": "pc1",
  "addon.list": "pc1",
  "item.list": "pc2",
  "itemPrice.list": "pc2",
  "itemFamily.list": "pc2",
};

/** Derive an operation's catalog from which specs contain it. Fail open to "both". */
function deriveOpCatalog(opIdV2: string, opIdV1: string, key: string): CatalogTag {
  if (FORCE_BOTH.has(key)) return "both";
  const hasV2 = !!opIdV2;
  const hasV1 = !!opIdV1;
  if (hasV2 && !hasV1) return "pc2";
  if (hasV1 && !hasV2) return "pc1";
  return "both"; // present in both, or neither (unmapped) ⇒ fail open
}

function camelToKebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}
function camelToSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
function toPascal(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const IRREGULAR_PLURALS: Record<string, string> = {
  entity: "entities", family: "families", history: "histories",
  entry: "entries", policy: "policies", currency: "currencies",
};
function pluralize(word: string): string {
  if (IRREGULAR_PLURALS[word]) return IRREGULAR_PLURALS[word];
  if (/(?:s|x|sh|ch)$/.test(word)) return word + "es";
  return word + "s";
}
function humanName(kebab: string): string {
  const parts = kebab.split("-");
  parts[parts.length - 1] = pluralize(parts[parts.length - 1]);
  return parts.join(" ");
}

/** Normalise a path so SDK `{id}` and spec `{customer-id}` placeholders match. */
function normPath(p: string): string {
  return p.replace(/\{[^}]+\}/g, "{}").replace(/\/+$/, "");
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPEC_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Load a spec from a file override, the cache, or the network (cached on fetch). */
async function loadSpec(label: string, url: string, fileOverride: string | undefined, cacheName: string): Promise<Record<string, unknown>> {
  if (fileOverride) {
    console.log(`[${label}] using local file ${fileOverride}`);
    return JSON.parse(readFileSync(resolve(fileOverride), "utf-8"));
  }

  const cachePath = join(cacheDir, cacheName);
  const cached = existsSync(cachePath);

  if (cached && !has("--refresh")) {
    console.log(`[${label}] using cached spec ${cachePath}`);
    return JSON.parse(readFileSync(cachePath, "utf-8"));
  }

  if (has("--offline")) {
    throw new Error(`[${label}] --offline set but no cached spec at ${cachePath}. Run once online to populate the cache.`);
  }

  console.log(`[${label}] fetching ${url}`);
  const text = await fetchText(url);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cachePath, text);
  return JSON.parse(text);
}

interface SpecOp {
  operationId: string;
  summary: string;
  argument?: ArgumentHelp;
  example?: (resource: string, operation: string) => string[] | undefined;
}

/** Build a (METHOD:normalised-path) → {operationId, summary} map from a spec. */
function buildSpecMap(spec: Record<string, unknown>): Map<string, SpecOp> {
  const map = new Map<string, SpecOp>();
  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of ["get", "post", "put", "delete", "patch"]) {
      const op = pathItem[method] as Record<string, unknown> | undefined;
      if (op?.operationId) {
        map.set(`${method.toUpperCase()}:${normPath(path)}`, {
          operationId: op.operationId as string,
          summary: typeof op.summary === "string" ? op.summary.trim() : "",
          argument: specArgument(spec, path, pathItem, op),
          example: (resource, operation) => specExample(spec, resource, operation, path, pathItem, op),
        });
      }
    }
  }
  return map;
}

/** Turn an SDK action like "addContact" / "createForChargeItem" into "Add contact". */
function humanizeAction(action: string): string {
  const words = action
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

async function loadEndpoints(): Promise<Resource[]> {
  const [specV2, specV1] = await Promise.all([
    loadSpec("v2-pc2", SPEC_V2_URL, flag("--spec-file-v2"), "chargebee_api_v2_pc_v2_spec.json"),
    loadSpec("v2-pc1", SPEC_V1_URL, flag("--spec-file-v1"), "chargebee_api_v2_pc_v1_spec.json"),
  ]);
  const v2Map = buildSpecMap(specV2);
  const v1Map = buildSpecMap(specV1);
  console.log(`Loaded operationIds: PC2=${v2Map.size}, PC1=${v1Map.size}`);

  const resources: Resource[] = [];

  for (const [sdkName, endpoints] of Object.entries(Endpoints)) {
    const ops: Operation[] = (endpoints as unknown[]).map((ep: unknown) => {
      const t = ep as [string, string, string, string | null, boolean];
      const urlPrefix = t[2];
      const urlSuffix = t[3] ?? "";
      const hasId = t[4] === true;
      const fullPath = hasId ? `${urlPrefix}/{id}${urlSuffix}` : `${urlPrefix}${urlSuffix}`;
      const key = `${t[1]}:${normPath(fullPath)}`;
      const specV2Op = v2Map.get(key);
      const specV1Op = v1Map.get(key);
      const operationIdV2 = specV2Op?.operationId ?? "";
      const operationIdV1 = specV1Op?.operationId ?? "";

      return {
        sdkAction: t[0],
        cliCommand: camelToKebab(t[0]),
        method: t[1],
        urlPrefix,
        urlSuffix,
        hasId,
        operationIdV2,
        operationIdV1,
        catalog: deriveOpCatalog(operationIdV2, operationIdV1, `${sdkName}.${t[0]}`),
        summary: specV2Op?.summary || specV1Op?.summary || humanizeAction(t[0]),
        argument: specV2Op?.argument ?? specV1Op?.argument,
        // A mapped PC2 operation is authoritative, even when its schema cannot
        // produce a safe example. Never fill that gap from the PC1 spec.
        example: specV2Op
          ? specV2Op.example?.(camelToKebab(sdkName), camelToKebab(t[0]))
          : specV1Op?.example?.(camelToKebab(sdkName), camelToKebab(t[0])),
      };
    });

    ops.sort((a, b) => a.sdkAction.localeCompare(b.sdkAction));


    // Schema-only SDK keys (token, contact, discount, …) have no operations.
    // They are valid Chargebee objects / docs pages, not callable CLI commands.
    if (ops.length === 0) continue;
    const cliName = camelToKebab(sdkName);
    resources.push({
      sdkName,
      cliName,
      snakeName: camelToSnake(sdkName),
      humanName: humanName(cliName),
      operations: ops,
    });
  }

  // Sanity-check the catalog-defining operations classified as expected.
  const assertionMismatches: string[] = [];
  for (const r of resources) {
    for (const op of r.operations) {
      const key = `${r.sdkName}.${op.sdkAction}`;
      const expected = CATALOG_OP_ASSERTIONS[key];
      if (expected && op.catalog !== expected) {
        assertionMismatches.push(`${key}: expected ${expected}, got ${op.catalog}`);
      }
    }
  }
  if (assertionMismatches.length > 0) {
    throw new Error(
      `Catalog operation assertion(s) failed — the public spec may have changed:\n  ` +
        assertionMismatches.join("\n  ")
    );
  }

  resources.sort((a, b) => a.sdkName.localeCompare(b.sdkName));
  return resources;
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Only the standard List API (`list`) honors filter operator suffixes.
 * `list-*` variants are sub-resource / specialized listings that do not, so
 * they must not get the filter help block or the bare-key warning.
 */
function isListOp(cliCommand: string): boolean {
  return cliCommand === "list";
}

function generateResourceFile(r: Resource): string {
  const L: string[] = [];

  L.push(`// Code generated by src/tools/generate.ts from Chargebee SDK endpoints. DO NOT EDIT.`);
  L.push(`// Regenerate with: bun run generate\n`);
  const hasGatedOp = r.operations.some((op) => op.catalog !== "both");
  const hasListOp = r.operations.some((op) => isListOp(op.cliCommand));
  const hasIdOp = r.operations.some((op) => op.hasId);
  const sdkImports = hasGatedOp
    ? "getClient, ensureWriteAllowed, ensureCatalogAllowed"
    : "getClient, ensureWriteAllowed";
  const stdinFns = ["loadOperationParams"];
  if (hasIdOp) stdinFns.push("takeResourceId");
  if (r.operations.some((op) => !op.hasId)) stdinFns.push("readJsonMarker");
  if (hasListOp) stdinFns.push("warnBareJsonFilters");

  L.push(`import { Option, type Command } from "commander";\n`);
  L.push(`import { ${sdkImports} } from "../../lib/api/sdk.js";`);
  L.push(`import { handleSdkError, printResult } from "../../lib/api/print.js";`);
  L.push(`import { ${hasIdOp ? "assertResourceId, " : ""}handleCodeSample } from "../../lib/api/generated-command.js";`);
  if (hasListOp) {
    L.push(`import { warnBareListFilters } from "../../lib/codesample/index.js";`);
  }
  L.push(`import { ${stdinFns.join(", ")} } from "../../lib/api/stdin-params.js";\n`);

  L.push(`export function register${toPascal(r.sdkName)}(parent: Command): void {`);
  L.push(`  const cmd = parent`);
  L.push(`    .command("${r.cliName}")`);
  if (r.cliName !== r.snakeName) {
    L.push(`    .alias("${r.snakeName}")`);
  }
  L.push(`    .description("API operations for ${esc(r.humanName)}");\n`);

  for (const op of r.operations) {
    // The argument is optional at the parser level so samples work without an
    // id; for real API calls the action enforces it at runtime.
    const argument = op.argument ?? { name: "id", description: "Resource identifier." };
    const uri = op.hasId
      ? `${op.urlPrefix}/{id}${op.urlSuffix}`
      : `${op.urlPrefix}${op.urlSuffix}`;
    const csPathArgs = op.hasId
      ? `, resourceId: resource.id, pathParamName: ${op.argument ? JSON.stringify(op.argument.name) : "undefined"}`
      : "";
    const csArgs = `{ lang: opts.codeSample, opIdV2: "${esc(op.operationIdV2)}", opIdV1: "${esc(op.operationIdV1)}", method: "${op.method}", uri: "${esc(uri)}", dataFlags: opts.data ?? [], params${csPathArgs}, pcVersionFlag: opts.pcVersion }`;
    const isWrite =
      op.method.toUpperCase() !== "GET" && !isReadOnlyOperation(`${r.sdkName}.${op.sdkAction}`);
    const list = isListOp(op.cliCommand);
    const optsType = `{ data?: string[]; codeSample?: string; pcVersion?: string }`;
    const dataHelp = list
      ? "Parameters as key=value. List filters require an operator suffix (id[is]=…). Bare keys: limit, offset, include_deleted."
      : "Request parameters in key=value format; repeat for multiple fields";
    const listHelp =
      `\\n${JSON.stringify(sectionTitle("LIST FILTERS")).slice(1, -1)}\\n` +
      `  Filter fields need an operator suffix: [is], [in], [starts_with], [between], [gt], [lt], ...\\n` +
      `  Pagination uses bare keys: -d limit=10\\n` +
      `  See https://apidocs.chargebee.com/docs/api/list-ops\\n` +
      `  Per-resource Filter Params: chargebee docs ${r.cliName} list`;

    L.push(`  cmd`);
    L.push(`    .command("${op.cliCommand}")`);
    if (op.hasId) L.push(`    .argument(${JSON.stringify(`[${argument.name}]`)}, ${JSON.stringify(argument.description)})`);
    L.push(`    .argument("[json]", "'-' reads a JSON object from stdin.")`);
    const summary = r.cliName === "subscription" && op.cliCommand === "create-with-items"
      ? "Create a subscription for an existing customer using item prices"
      : op.summary;
    L.push(`    .description(${JSON.stringify(summary)})`);
    L.push(`    .option("-d, --data <pairs...>", "${esc(dataHelp)}")`);
    // Keep in sync with CODE_SAMPLE_OPTION_HELP in lib/codesample/index.ts
    L.push(`    .option("-s, --code-sample <lang>", "Generate code sample (curl, python, nodejs, go, ruby, java, php, dotnet, list)")`);
    // Preserve the existing override for scripts without foregrounding it in help.
    L.push(`    .addOption(new Option("--pc-version <version>", "Product catalog version for the code sample (v1 or v2)").hideHelp())`);
    if (list) {
      L.push(`    .addHelpText("after", "${listHelp}")`);
    }
    L.push(`    .addHelpText("after", ${JSON.stringify(operationHelp(r.cliName, op.cliCommand, !!(op.operationIdV2 || op.operationIdV1), op.example))})`);
    // Exclusive ops: same catalog gate as a real API call. `--code-sample list`
    // is not an API, so skip. `both` ops never emit the call.
    const emitCatalogThenSample = () => {
      if (op.catalog !== "both") {
        L.push(`      if (opts.codeSample !== "list") await ensureCatalogAllowed("${op.catalog}", "${r.cliName} ${op.cliCommand}");`);
      }
      L.push(`      if (opts.codeSample) return handleCodeSample(${csArgs});`);
    };

    if (op.hasId) {
      L.push(`    .action(async (id: string | undefined, json: string | undefined, opts: ${optsType}, command: Command) => {`);
      L.push(`      const resource = takeResourceId(id, json, command);`);
      L.push(`      const params = await loadOperationParams(opts.data ?? [], resource.fromStdin, command);`);
      emitCatalogThenSample();
      if (list) {
        L.push(`      if (resource.fromStdin) warnBareJsonFilters(params, "${r.cliName}");`);
        L.push(`      else warnBareListFilters(opts.data ?? [], "${r.cliName}");`);
      }
      L.push(`      if (!resource.id) command.error(${JSON.stringify(`error: missing required argument '${argument.name}'`)});`);
      L.push(`      assertResourceId(resource.id, command);`);
      if (isWrite) L.push(`      await ensureWriteAllowed("${op.method}");`);
      L.push(`      try {`);
      L.push(`        const client = await getClient();`);
      L.push(`        const result = await (client as any).${r.sdkName}.${op.sdkAction}(resource.id, params);`);
      L.push(`        printResult(result);`);
      L.push(`      } catch (e) { handleSdkError(e); }`);
      L.push(`    });\n`);
    } else {
      L.push(`    .action(async (json: string | undefined, opts: ${optsType}, command: Command) => {`);
      L.push(`      const fromStdin = readJsonMarker(json, command);`);
      L.push(`      const params = await loadOperationParams(opts.data ?? [], fromStdin, command);`);
      emitCatalogThenSample();
      if (list) {
        L.push(`      if (fromStdin) warnBareJsonFilters(params, "${r.cliName}");`);
        L.push(`      else warnBareListFilters(opts.data ?? [], "${r.cliName}");`);
      }
      if (isWrite) L.push(`      await ensureWriteAllowed("${op.method}");`);
      L.push(`      try {`);
      L.push(`        const client = await getClient();`);
      L.push(`        const result = await (client as any).${r.sdkName}.${op.sdkAction}(params);`);
      L.push(`        printResult(result);`);
      L.push(`      } catch (e) { handleSdkError(e); }`);
      L.push(`    });\n`);
    }
  }

  L.push(`}`);
  return L.join("\n");
}

function generateRegistry(resources: Resource[]): string {
  const L: string[] = [];

  L.push(`// Code generated by src/tools/generate.ts from Chargebee SDK endpoints. DO NOT EDIT.`);
  L.push(`// Regenerate with: bun run generate\n`);
  L.push(`import type { Command } from "commander";\n`);

  for (const r of resources) {
    L.push(`import { register${toPascal(r.sdkName)} } from "./${r.snakeName}.js";`);
  }

  L.push(`\nimport { setCommandGroup } from "../help.js";\n`);
  L.push(`// Every resource is registered as a top-level command (e.g. \`chargebee item list\`)`);
  L.push(`// and tagged into the "resource" group so help can list them together.`);
  L.push(`export function registerAll(rootCmd: Command): void {`);

  for (const r of resources) {
    L.push(`  register${toPascal(r.sdkName)}(rootCmd);`);
    L.push(`  { const cmd = rootCmd.commands.find(c => c.name() === "${r.cliName}"); if (cmd) setCommandGroup(cmd, "resource"); }`);
  }

  L.push(`}`);
  return L.join("\n");
}

const resources = await loadEndpoints();
const totalOps = resources.reduce((n, r) => n + r.operations.length, 0);

const { unmapped } = auditOperationIds(resources);
if (unmapped.length > 0) {
  // Informational only: these SDK endpoints have no operationId in either public
  // spec, so `--code-sample` is unavailable for them. This is not a failure — the
  // command is still generated from the SDK and works against the API.
  console.log(`\nℹ ${unmapped.length} operation(s) have no operationId in either spec (no code sample):`);
  for (const id of unmapped) console.log(`    ${id}`);
}

const allOps = resources.flatMap((r) => r.operations.map((op) => ({ name: `${r.cliName} ${op.cliCommand}`, catalog: op.catalog })));
const pc1Ops = allOps.filter((o) => o.catalog === "pc1");
const pc2Ops = allOps.filter((o) => o.catalog === "pc2");
console.log(
  `\nCatalog filtering (gated operations): ${pc1Ops.length} PC1-only, ${pc2Ops.length} PC2-only, ` +
    `${allOps.length - pc1Ops.length - pc2Ops.length} catalog-neutral (both/unmapped).`
);

console.log(`\nGenerating ${resources.length} resources (${totalOps} operations) to ${outDir}/`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const r of resources) {
  writeFileSync(join(outDir, `${r.snakeName}.ts`), generateResourceFile(r));
}

writeFileSync(join(outDir, "registry.ts"), generateRegistry(resources));
const withSamples = totalOps - unmapped.length;
console.log(`Done. Generated ${resources.length} resource files + registry.ts`);
console.log(`Code samples available for ~${withSamples}/${totalOps} operations (${unmapped.length} unmapped in specs).`);
