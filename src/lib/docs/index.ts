import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { configDir } from "../config/store.js";

const DEFAULT_HOST = "https://apidocs.chargebee.com";
const API_PREFIX = "/docs/api";

let cachedHost: string | null = null;

/**
 * Resolve the docs host, validating `CB_API_DOCS_HOST` when set: only
 * `https://` is allowed, unless the hostname is `localhost` or `127.0.0.1`
 * for local testing, so this can never be pointed at a plaintext origin.
 */
function resolveHost(): string {
  if (cachedHost !== null) return cachedHost;

  const raw = process.env.CB_API_DOCS_HOST;
  if (!raw) {
    cachedHost = DEFAULT_HOST;
    return cachedHost;
  }

  const trimmed = raw.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid CB_API_DOCS_HOST: ${raw}`);
  }
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !isLocal) {
    throw new Error(
      `CB_API_DOCS_HOST must use https:// (http:// is only allowed for localhost/127.0.0.1): ${raw}`,
    );
  }
  cachedHost = trimmed;
  return cachedHost;
}

/** Honours `CHARGEBEE_CONFIG_DIR` like every other writer under the config dir. */
function cacheDir(): string {
  return join(configDir(), "docs-cache");
}
function sitemapCache(): string {
  return join(cacheDir(), "sitemap.json");
}
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 15_000;
/** Hard cap on a fetched doc/sitemap body; larger responses are rejected. */
const MAX_DOC_BYTES = 5 * 1024 * 1024; // 5 MB

/** Parsed sitemap: resource segment → its operation pages (rest-path → full path). */
interface SitemapIndex {
  /** plural resource segment (e.g. "customers") → Map<opRest, fullPath> */
  resources: Map<string, Map<string, string>>;
}

export type DocResult =
  | { ok: true; url: string; body: string }
  | { ok: false; reason: "offline" | "not_found"; operations?: string[] };

/** Strip control characters that could inject terminal escape sequences, keeping the whitespace a reader actually wants. */
export function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching C0 (except \t\n\r) and C1 control ranges
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "");
}

/** Read a response body, aborting once it exceeds `MAX_DOC_BYTES`. Returns null if it does. */
async function readCappedText(r: Response): Promise<string | null> {
  const contentLength = r.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_DOC_BYTES) return null;

  if (!r.body) {
    const text = await r.text();
    return text.length > MAX_DOC_BYTES ? null : text;
  }

  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_DOC_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return r.ok ? await readCappedText(r) : null;
  } catch {
    return null;
  }
}

async function readFreshCache(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs > TTL_MS) return null;
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

async function writeCache(path: string, body: string): Promise<void> {
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(cacheDir(), { recursive: true, mode: 0o700 });
    await writeFile(path, body);
  } catch {
    /* cache write failures must not break the command */
  }
}

/** SDK method names are camelCase/snake_case; doc slugs are kebab-case. */
function toKebab(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function singular(seg: string): string {
  return seg
    .replace(/ies$/, "y")
    .replace(/ses$/, "s")
    .replace(/s$/, "");
}

/** Filler words dropped when token-matching an SDK name against a doc slug. */
const FILLER = new Set(["a", "an", "the", "for", "to", "of", "and", "with", "as"]);

/** Significant kebab tokens of a string (filler words removed). */
function sigTokens(s: string): string[] {
  return toKebab(s)
    .split("-")
    .filter((t) => t && !FILLER.has(t));
}

let memoIndex: SitemapIndex | null = null;

/** TEST-ONLY: drop the in-memory sitemap (and resolved host) so tests can re-fetch. */
export function __resetDocsMemoForTest(): void {
  memoIndex = null;
  cachedHost = null;
}

/** @internal exported for tests */
export function parseSitemap(xml: string): SitemapIndex {
  const resources = new Map<string, Map<string, string>>();
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const path = m[1].replace(resolveHost(), "");
    if (!path.startsWith(`${API_PREFIX}/`)) continue;
    const rest = path.slice(API_PREFIX.length + 1); // e.g. "customers/create-a-customer"
    const slash = rest.indexOf("/");
    if (slash === -1) continue; // resource landing page, not an operation
    const seg = rest.slice(0, slash);
    // Skip versioned/legacy trees (/docs/api/v1/..., /docs/api/v2/pcv-1/...).
    // The CLI targets the current (unversioned) API; treating "v1" as a
    // resource would surface a bogus resource grouping every v1 page.
    if (/^v\d+$/.test(seg)) continue;
    const op = rest.slice(slash + 1);
    if (!resources.has(seg)) resources.set(seg, new Map());
    resources.get(seg)!.set(op, path);
  }
  return { resources };
}

/** Load the sitemap (fresh cache → network → stale cache). Returns null if unavailable. */
async function loadIndex(): Promise<SitemapIndex | null> {
  if (memoIndex) return memoIndex;

  const cached = await readFreshCache(sitemapCache());
  if (cached) {
    memoIndex = deserialize(cached);
    return memoIndex;
  }

  const xml = await fetchText(`${resolveHost()}/sitemap.xml`);
  if (xml) {
    memoIndex = parseSitemap(xml);
    await writeCache(sitemapCache(), serialize(memoIndex));
    return memoIndex;
  }

  // Network failed — fall back to a stale cache if one exists.
  try {
    const stale = await readFile(sitemapCache(), "utf-8");
    memoIndex = deserialize(stale);
    return memoIndex;
  } catch {
    return null;
  }
}

function serialize(idx: SitemapIndex): string {
  const obj: Record<string, Record<string, string>> = {};
  for (const [seg, ops] of idx.resources) obj[seg] = Object.fromEntries(ops);
  return JSON.stringify(obj);
}

function deserialize(json: string): SitemapIndex {
  const obj = JSON.parse(json) as Record<string, Record<string, string>>;
  const resources = new Map<string, Map<string, string>>();
  for (const [seg, ops] of Object.entries(obj)) {
    resources.set(seg, new Map(Object.entries(ops)));
  }
  return { resources };
}

/** Map a CLI resource name (often singular, e.g. "customer") to a sitemap segment. @internal */
export function resolveSegment(idx: SitemapIndex, name: string): string | null {
  const r = idx.resources;
  if (r.has(name)) return name;
  for (const cand of [`${name}s`, name.replace(/y$/, "ies"), `${name}es`]) {
    if (r.has(cand)) return cand;
  }
  const want = singular(name);
  for (const seg of r.keys()) {
    if (singular(seg) === want) return seg;
  }
  return null;
}

/**
 * Resolve an operation to its sitemap op-path. Tries, in order:
 *   1. exact slug,
 *   2. kebab of the SDK name (exact),
 *   3. kebab-prefix match (so `create` → the shortest `create-*`),
 *   4. unique token-subset — the one slug whose significant tokens are a
 *      superset of the SDK name's (filler words ignored), e.g.
 *      `checkoutOneTimeForItems` → `checkout-charge-items-and-one-time-charges`.
 *      Only used when exactly one slug matches, to avoid silent mis-resolution.
 * Returns null when nothing matches (caller shows the op list).
 * @internal exported for tests
 */
export function resolveOp(ops: Map<string, string>, op: string): string | null {
  if (ops.has(op)) return op;
  const k = toKebab(op);
  if (ops.has(k)) return k;
  const prefix = [...ops.keys()].filter((s) => s === k || s.startsWith(`${k}-`));
  if (prefix.length) return prefix.sort((a, b) => a.length - b.length)[0];

  const want = sigTokens(op);
  if (want.length) {
    const subset = [...ops.keys()].filter((s) => {
      const have = new Set(sigTokens(s));
      return want.every((t) => have.has(t));
    });
    if (subset.length === 1) return subset[0];
  }
  return null;
}

async function fetchMarkdown(path: string): Promise<string | null> {
  const url = `${resolveHost()}${path}.md`;
  const cachePath = join(cacheDir(), `${path.replace(/[^a-z0-9]/gi, "_")}.md`);
  const fresh = await readFreshCache(cachePath);
  if (fresh !== null) return fresh;
  const body = await fetchText(url);
  if (body !== null) {
    await writeCache(cachePath, body);
    return body;
  }
  // Network miss — serve stale cache if present.
  try {
    return await readFile(cachePath, "utf-8");
  } catch {
    return null;
  }
}

/** Sorted list of resource segments known to the sitemap. Empty if offline+cold. */
export async function listResources(): Promise<string[]> {
  const idx = await loadIndex();
  if (!idx) return [];
  return [...idx.resources.keys()].sort();
}

/** Operation slugs available for a resource (sorted). */
export async function listOperations(name: string): Promise<string[]> {
  const idx = await loadIndex();
  if (!idx) return [];
  const seg = resolveSegment(idx, name);
  if (!seg) return [];
  return [...idx.resources.get(seg)!.keys()].sort();
}

/** Fetch the resource overview page markdown. */
export async function fetchResource(name: string): Promise<DocResult> {
  const idx = await loadIndex();
  if (!idx) return { ok: false, reason: "offline" };
  const seg = resolveSegment(idx, name);
  if (!seg) return { ok: false, reason: "not_found" };
  const url = `${resolveHost()}${API_PREFIX}/${seg}.md`;
  const body = await fetchMarkdown(`${API_PREFIX}/${seg}`);
  if (body === null) return { ok: false, reason: "offline" };
  return { ok: true, url, body };
}

/** Fetch a specific operation page markdown, resolving the SDK name to a slug. */
export async function fetchOperation(name: string, op: string): Promise<DocResult> {
  const idx = await loadIndex();
  if (!idx) return { ok: false, reason: "offline" };
  const seg = resolveSegment(idx, name);
  if (!seg) return { ok: false, reason: "not_found" };
  const ops = idx.resources.get(seg)!;
  const opPath = resolveOp(ops, op);
  if (!opPath) {
    return { ok: false, reason: "not_found", operations: [...ops.keys()].sort() };
  }
  const path = ops.get(opPath)!;
  const body = await fetchMarkdown(path);
  if (body === null) return { ok: false, reason: "offline" };
  return { ok: true, url: `${resolveHost()}${path}.md`, body };
}
