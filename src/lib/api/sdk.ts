import Chargebee from "chargebee";

import { diagnostic, exitCommand } from "../output.js";
import { assertValidProfileName, loadProfile, peekProfileMeta } from "../config/profiles.js";
import { readConfig } from "../config/store.js";
import {
  assertValidSiteName,
  parseHost,
  parseSiteInput,
  PRODUCTION_HOST,
  type ApiHost,
} from "../config/host.js";
import { DEFAULT_REGION, parseRegion, type Region } from "../config/region.js";
import { blockedWriteMessage, isWriteMethod, shouldBlockWrite } from "./write-gate.js";
import { blockedCatalogMessage, shouldBlockCatalog, type CatalogTag } from "./catalog-gate.js";
import { markUnconfigured, recordTelemetryError } from "../telemetry/error.js";
import { maybeWarnUnproxiedNode } from "./proxy.js";
import { EXIT_CODES } from "../exit-codes.js";

export { isLiveSite } from "./write-gate.js";
export type { ApiHost } from "../config/host.js";
export type { Region } from "../config/region.js";

/** Set by --profile global flag. Cleared on process start; forces re-init. */
let _profileOverride: string | null = null;
export function setProfile(name: string) {
  _profileOverride = assertValidProfileName(name);
  _client = null; // force re-init with new profile
  _authCache = null;
}

/** Process-level API host override. */
let _hostOverride: ApiHost | null = null;
export function setHostOverride(raw: string) {
  _hostOverride = parseHost(raw);
  _client = null;
}

let _client: InstanceType<typeof Chargebee> | null = null;

/**
 * Identifier appended to the SDK's User-Agent so CLI traffic is distinguishable
 * from merchants' own Node SDK usage. Set once at startup from the entry point (where
 * the resolved VERSION lives). Defaults to the bare name when unset (e.g. in tests).
 */
let _clientIdentifier = "chargebee-cli";
export function setClientIdentifier(id: string): void { _clientIdentifier = id; }

/** Client-side request timeout used when `CHARGEBEE_CLI_TIMEOUT_MS` is not set. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Resolve the client-side request timeout, in milliseconds. Overridable via
 * `CHARGEBEE_CLI_TIMEOUT_MS`; an unset, blank, or non-positive value falls
 * back to {@link DEFAULT_TIMEOUT_MS}.
 */
export function resolveTimeoutMs(): number {
  const raw = process.env.CHARGEBEE_CLI_TIMEOUT_MS;
  if (raw && raw.trim()) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TIMEOUT_MS;
}

/**
 * Build a Chargebee SDK client with the CLI's client identifier baked in.
 *
 * Passing `userAgentSuffix` in the constructor is the root-level equivalent of the
 * legacy `cb.__clientIdentifier(...)`: it sets `_env.userAgentSuffix`, which the SDK
 * appends to `User-Agent` as `Chargebee-NodeJs-Client <ver>;<userAgentSuffix>`.
 * `timeout` bounds every request the SDK makes (its own default is 80s); callers
 * pass {@link resolveTimeoutMs} so the value is set once at the call site and
 * visible to the client-factory test seam.
 */
function newChargeeClient(opts: {
  site: string;
  apiKey: string;
  hostSuffix: string;
  protocol?: "https" | "http";
  timeout?: number;
}): InstanceType<typeof Chargebee> {
  maybeWarnUnproxiedNode();
  return new Chargebee({
    site: opts.site,
    apiKey: opts.apiKey,
    hostSuffix: opts.hostSuffix,
    protocol: opts.protocol ?? "https",
    userAgentSuffix: _clientIdentifier,
    timeout: opts.timeout ?? DEFAULT_TIMEOUT_MS,
  });
}

/**
 * Indirection seam for the SDK client constructor. Production always uses the
 * real builder above; isolated CLI tests swap in a fake via
 * `__setClientFactory` so the full command/resolution flow can run without
 * credentials or network. The SDK exposes no base-URL override, so injecting the
 * client here is the cleanest mock point.
 */
type ClientFactory = typeof newChargeeClient;
let clientFactory: ClientFactory = newChargeeClient;

/** TEST-ONLY: replace the SDK client builder (pass null to restore the real one). Clears the cached client. */
export function __setClientFactory(fn: ClientFactory | null): void {
  clientFactory = fn ?? newChargeeClient;
  _client = null;
}

/** TEST-ONLY: reset module-level runtime state between in-process CLI runs. Does not touch the client factory. */
export function __resetRuntimeState(): void {
  _client = null;
  _profileOverride = null;
  _hostOverride = null;
  _authCache = null;
}

/**
 * Resolve the API host (`{site}{suffix}`) for the current invocation.
 *
 * Order: process override, then the selected profile's `host`, then
 * `CHARGEBEE_HOST` when no profile is selected, then production.
 * An explicit value fails when it is not a known host. `host` is a plain
 * on-disk field, so this reads the profile file directly and never touches
 * the OS keychain.
 */
export async function resolveApiHost(): Promise<ApiHost> {
  if (_hostOverride) return _hostOverride;

  if (_profileOverride) {
    const p = await peekProfileMeta(_profileOverride);
    if (p?.host) return parseHost(p.host);
    return PRODUCTION_HOST;
  }

  // Env-var auth does not read a stored profile host.
  if (process.env.CHARGEBEE_SITE && process.env.CHARGEBEE_API_KEY) {
    return hostFromEnvOrProduction();
  }

  const cfg = await readConfig();
  if (cfg.activeProfile) {
    const p = await peekProfileMeta(cfg.activeProfile);
    if (p?.host) return parseHost(p.host);
    return PRODUCTION_HOST;
  }

  return hostFromEnvOrProduction();
}

function hostFromEnvOrProduction(): ApiHost {
  const fromHost = process.env.CHARGEBEE_HOST;
  if (fromHost && fromHost.trim()) return parseHost(fromHost);
  return PRODUCTION_HOST;
}

/**
 * Resolve the Chargebee region (`{@link Region}`) for the current invocation.
 *
 * Order: `CHARGEBEE_REGION` → profile `region` → `us`. An invalid value throws,
 * so the result is either the configured region or an error. `region` is a plain
 * on-disk field, so this reads the profile file directly and never touches the
 * OS keychain.
 */
export async function resolveRegion(): Promise<Region> {
  const fromEnv = process.env.CHARGEBEE_REGION;
  if (fromEnv && fromEnv.trim()) return parseRegion(fromEnv);

  if (_profileOverride) {
    const p = await peekProfileMeta(_profileOverride);
    return p?.region ? parseRegion(p.region) : DEFAULT_REGION;
  }

  // Env-var auth does not read a stored profile region.
  if (process.env.CHARGEBEE_SITE && process.env.CHARGEBEE_API_KEY) {
    return DEFAULT_REGION;
  }

  // The catch covers an unreadable config only; parsing stays outside it so a
  // stored region is never replaced by the default.
  let saved: string | undefined;
  try {
    const cfg = await readConfig();
    if (cfg.activeProfile) {
      saved = (await peekProfileMeta(cfg.activeProfile))?.region;
    }
  } catch {
    // No readable config — default region.
  }

  return saved ? parseRegion(saved) : DEFAULT_REGION;
}

/**
 * Get a configured Chargebee SDK client.
 * Resolution order: --profile flag → env vars → active profile → legacy config.
 * Instance is cached for process lifetime (reset on setProfile).
 */
export async function getClient(): Promise<InstanceType<typeof Chargebee>> {
  if (_client) return _client;
  const { site, apiKey } = await resolveAuth();
  const host = await resolveApiHost();
  _client = clientFactory({
    site: assertValidSiteName(site),
    apiKey,
    hostSuffix: host.suffix,
    protocol: host.protocol,
    timeout: resolveTimeoutMs(),
  });
  return _client;
}

/** SDK throws plain objects, not Error instances — extract message safely. */
function sdkMessage(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as Record<string, unknown>).message);
  }
  return err instanceof Error ? err.message : String(err);
}

function sdkHttpStatus(err: unknown): number {
  return (typeof err === "object" && err !== null && "http_status_code" in err)
    ? (err as { http_status_code: number }).http_status_code
    : 0;
}

/**
 * Error codes that mean the request never reached (or heard back from) the host.
 * The `E*` names are libuv/undici codes; the CamelCase names are what Bun's
 * `fetch` sets as `err.code` (its message is a generic "Unable to connect…").
 */
const NETWORK_ERROR_CODES = [
  "ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH",
  "ConnectionRefused", "ConnectionClosed", "ConnectionTimedOut", "DNSException", "FailedToOpenSocket",
];

/** A transport-level failure: DNS/connection/timeout, as opposed to an HTTP response from Chargebee. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/**
 * Identify a transport-level failure and return its code. Node's global `fetch`
 * throws `TypeError: fetch failed` with the real reason on `err.cause.code`;
 * Bun's `fetch` puts its own code directly on `err.code`; the SDK's request
 * timeout surfaces as `type: "timeout"`; a bare `getaddrinfo ENOTFOUND …`
 * style message is matched as a last resort.
 */
export function transportErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { name?: string; type?: string; code?: unknown; cause?: unknown };
  if (e.name === "AbortError" || e.name === "TimeoutError" || e.type === "timeout") return "ETIMEDOUT";
  for (const holder of [e.cause, e]) {
    if (holder && typeof holder === "object" && "code" in holder) {
      const code = String((holder as { code?: unknown }).code);
      if (NETWORK_ERROR_CODES.includes(code)) return code;
    }
  }
  const msg = sdkMessage(err);
  return NETWORK_ERROR_CODES.find((code) => msg.includes(code));
}

/** Map an SDK error to a user-facing auth Error. */
function mapAuthError(site: string, err: unknown): Error {
  const status = sdkHttpStatus(err);

  if (status === 404) {
    return new Error(`Site "${site}" not found. Check the site name — use just "acme-test", not the full URL.`);
  }
  if (status === 401) {
    return new Error(`Invalid API key for "${site}". Check your API key and try again.`);
  }
  const netCode = transportErrorCode(err);
  if (netCode) {
    return new NetworkError(`Could not reach "${site}": ${netCode}. Check your network connection.`);
  }
  return new Error(sdkMessage(err));
}

/** Catalog metadata for a site, detected from the Configuration API. */
export interface CatalogInfo {
  productCatalogVersion?: string;
  responseSchemaType?: string;
}

/**
 * Validate credentials and detect the site's product catalog version in a
 * single call to the Configuration API.
 *
 * Only a 2xx response counts as verified. 401 and 404 map to friendly
 * "bad key" / "bad site" errors; a transport failure (DNS, connection
 * refused, timeout) throws a `NetworkError`; a 403 means the key
 * authenticated but may not read the Configuration API, so it returns an
 * empty CatalogInfo (catalog unknown, credentials valid); any other status
 * or error throws, naming the status, so a caller never treats an
 * unverified site as connected.
 */
export async function detectCatalog(site: string, apiKey: string): Promise<CatalogInfo> {
  site = assertValidSiteName(site);
  const host = await resolveApiHost();
  const client = clientFactory({
    site,
    apiKey,
    hostSuffix: host.suffix,
    protocol: host.protocol,
    timeout: resolveTimeoutMs(),
  });
  try {
    const resp = await (client as unknown as {
      configuration: { list: () => Promise<{ configurations?: Array<{ product_catalog_version?: string; chargebee_response_schema_type?: string }> }> };
    }).configuration.list();
    const first = resp?.configurations?.[0];
    return {
      productCatalogVersion: first?.product_catalog_version,
      responseSchemaType: first?.chargebee_response_schema_type,
    };
  } catch (err: unknown) {
    const status = sdkHttpStatus(err);
    if (status === 401 || status === 404) throw mapAuthError(site, err);
    if (transportErrorCode(err)) throw mapAuthError(site, err);
    if (status === 403) return {};
    if (status > 0) {
      throw new Error(`Chargebee returned ${status}; credentials not verified.`);
    }
    throw new Error(`${sdkMessage(err)}; credentials not verified.`);
  }
}

async function resolveCachedProfileField(
  field: "product_catalog_version" | "chargebee_response_schema_type",
): Promise<string | undefined> {
  if (_profileOverride) {
    const p = await peekProfileMeta(_profileOverride);
    return p?.[field];
  }
  if (process.env.CHARGEBEE_SITE && process.env.CHARGEBEE_API_KEY) return undefined;
  const cfg = await readConfig();
  if (cfg.activeProfile) {
    const p = await peekProfileMeta(cfg.activeProfile);
    return p?.[field];
  }
  return undefined;
}

export async function resolveCatalogVersion(): Promise<string | undefined> {
  return resolveCachedProfileField("product_catalog_version");
}

export async function resolveSchemaType(): Promise<string | undefined> {
  return resolveCachedProfileField("chargebee_response_schema_type");
}

/** Block exclusive catalog ops when the cached site mode disagrees. Unknown catalog fails open. */
export async function ensureCatalogAllowed(opCatalog: CatalogTag, commandName: string): Promise<void> {
  if (opCatalog === "both") return;

  let pcv: string | undefined;
  let schemaType: string | undefined;
  try {
    pcv = await resolveCatalogVersion();
    schemaType = await resolveSchemaType();
  } catch {
    return; // unknown ⇒ fail open
  }

  if (!shouldBlockCatalog(pcv, schemaType, opCatalog)) return;

  recordTelemetryError("catalog_blocked");
  diagnostic(blockedCatalogMessage(commandName, opCatalog, pcv, schemaType));
  exitCommand(EXIT_CODES.REFUSED, "catalog_refused");
}

/** Block writes on live sites. Unresolved credentials fail open so the API error surfaces. */
export async function ensureWriteAllowed(method: string): Promise<void> {
  if (!isWriteMethod(method)) return;

  let site: string;
  let apiKey: string;
  try {
    ({ site, apiKey } = await resolveAuth());
  } catch {
    return; // let the real call produce the configuration error
  }

  if (!shouldBlockWrite({ method, site, apiKey })) return;

  recordTelemetryError("write_blocked");
  diagnostic(blockedWriteMessage(site));
  exitCommand(EXIT_CODES.REFUSED, "live_write_refused");
}

/**
 * Resolve just the active site name for the current context, never throwing.
 * Returns undefined when nothing is configured. Goes through {@link resolveAuth},
 * so for a keychain-backed profile this reads the OS keychain the same as any
 * other credential resolution — callers that must stay cheap (telemetry) use
 * {@link peekActiveSiteName} instead.
 */
export async function resolveActiveSiteName(): Promise<string | undefined> {
  try {
    const { site } = await resolveAuth();
    return site;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the active site name the same way {@link resolveActiveSiteName} does,
 * but without ever touching the OS keychain: reads only `CHARGEBEE_SITE` or the
 * `site` field of the active profile file on disk. Never the API key, never the
 * key store. Used by telemetry, which resolves this on every command and must
 * stay cheap even for non-API commands.
 */
export async function peekActiveSiteName(): Promise<string | undefined> {
  try {
    if (_profileOverride) {
      const p = await peekProfileMeta(_profileOverride);
      return p?.site ? assertValidSiteName(p.site) : undefined;
    }

    const envSite = process.env.CHARGEBEE_SITE;
    const envKey = process.env.CHARGEBEE_API_KEY;
    if (envSite && envKey) return parseSiteInput(envSite).site;

    const cfg = await readConfig();
    if (cfg.activeProfile) {
      const p = await peekProfileMeta(cfg.activeProfile);
      return p?.site ? assertValidSiteName(p.site) : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cached result of a successful {@link resolveAuth} call. A write command
 * calls both `ensureWriteAllowed` and `getClient`, which each need the
 * resolved credentials; caching here means the profile (and, for a
 * keychain-backed one, the OS keychain) is only read once per command instead
 * of once per caller. Cleared by `setProfile` and `__resetRuntimeState` — the
 * two places the resolved profile can change within a process.
 */
let _authCache: { site: string; apiKey: string } | null = null;

/**
 * Resolve site + API key the same way API commands do (profile / env / configure).
 * The site is always validated (and `CHARGEBEE_SITE` normalised, so
 * `acme-test.chargebee.com` becomes `acme-test`) before it can reach a URL.
 */
export async function resolveAuth(): Promise<{ site: string; apiKey: string }> {
  if (_authCache) return _authCache;
  const resolved = await resolveAuthUncached();
  _authCache = resolved;
  return resolved;
}

async function resolveAuthUncached(): Promise<{ site: string; apiKey: string }> {
  // 1. --use-profile flag
  if (_profileOverride) {
    const p = await loadProfile(_profileOverride);
    if (!p) {
      throw markUnconfigured(
        new Error(
          `Profile "${_profileOverride}" not found.\n\n  Run: chargebee auth add --profile ${_profileOverride}`,
        ),
      );
    }
    return { site: assertValidSiteName(p.site), apiKey: p.api_key };
  }

  // 2. Env vars — both must be set together
  const envSite = process.env.CHARGEBEE_SITE;
  const envKey = process.env.CHARGEBEE_API_KEY;
  if (envSite && envKey) return { site: parseSiteInput(envSite).site, apiKey: envKey };
  if (envSite || envKey) {
    const missing = envSite ? "CHARGEBEE_API_KEY" : "CHARGEBEE_SITE";
    throw markUnconfigured(
      new Error(
        `${missing} is not set.\n\n  Both CHARGEBEE_SITE and CHARGEBEE_API_KEY must be exported together.`,
      ),
    );
  }

  // 3. Active named profile
  const cfg = await readConfig();
  if (cfg.activeProfile) {
    const p = await loadProfile(cfg.activeProfile);
    if (p) return { site: assertValidSiteName(p.site), apiKey: p.api_key };
    throw markUnconfigured(
      new Error(
        `Active profile "${cfg.activeProfile}" not found on disk.\n\n  Run: chargebee auth add --profile ${cfg.activeProfile}\n  Or:  chargebee auth list`,
      ),
    );
  }

  // 4. Clean break: credentials from an older CLI version are no longer read.
  if (cfg.domain) {
    throw markUnconfigured(
      new Error(
        "Your saved credentials are from an older version of the CLI and are no longer supported.\n\n  Run: chargebee auth add",
      ),
    );
  }

  throw markUnconfigured(
    new Error(
      "Not configured.\n\n  Run: chargebee auth add\n  Or:  export CHARGEBEE_SITE=your-site CHARGEBEE_API_KEY=test_xxx",
    ),
  );
}
