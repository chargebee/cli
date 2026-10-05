/**
 * API host = the domain after the site name.
 *
 * Chargebee API URLs are always `{protocol}://{site}{suffix}`: acme.chargebee.com
 *
 * Production (`.chargebee.com`) is the default. A profile may store another host.
 */

export type ApiProtocol = "https" | "http";

export interface ApiHost {
  /** SDK `hostSuffix`, always with a leading dot (e.g. `.chargebee.com`). */
  suffix: string;
  protocol: ApiProtocol;
  isProduction: boolean;
}

export const PRODUCTION_SUFFIX = ".chargebee.com";

export const PRODUCTION_HOST: ApiHost = {
  suffix: PRODUCTION_SUFFIX,
  protocol: "https",
  isProduction: true,
};

/** Well-known aliases → suffix. Keys are lowercase, with or without a leading dot. */
const ALIASES: Record<string, string> = {
  production: PRODUCTION_SUFFIX,
  prod: PRODUCTION_SUFFIX,
  "chargebee.com": PRODUCTION_SUFFIX,
  [PRODUCTION_SUFFIX]: PRODUCTION_SUFFIX,
};

/**
 * True when `hostname` (e.g. `acme.chargebee.com`, `support.chargebee.com`)
 * sits under a suffix the CLI is allowed to talk to. Used to gate URLs the CLI
 * hands to a browser; the hostname must have at least one label before the suffix.
 */
export function isAllowedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h.length > PRODUCTION_SUFFIX.length && h.endsWith(PRODUCTION_SUFFIX);
}

function hostFromSuffix(suffix: string, protocol: ApiProtocol): ApiHost {
  const normalized = suffix.startsWith(".") ? suffix : `.${suffix}`;
  if (protocol !== "https") throw new Error("Only HTTPS is supported for API hosts.");
  return {
    suffix: normalized,
    protocol,
    isProduction: normalized === PRODUCTION_SUFFIX,
  };
}

/**
 * Parse a user/env/profile host value into an ApiHost.
 *
 * Production aliases and full production site URLs are recognised. Custom
 * values are domain suffixes (for example api.example.com), without a site label.
 */
export function parseHost(raw: string): ApiHost {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(invalidHostMessage(raw));
  }

  let protocol: ApiProtocol = "https";
  let s = trimmed;
  if (/^https:\/\//i.test(s)) {
    s = s.replace(/^https:\/\//i, "");
  } else if (/^http:\/\//i.test(s)) {
    protocol = "http";
    s = s.replace(/^http:\/\//i, "");
  }
  s = s.replace(/\/.*$/, "");
  s = s.replace(/:\d+$/, "");
  s = s.toLowerCase();
  if (!s) throw new Error(invalidHostMessage(raw));

  const aliased = ALIASES[s];
  if (typeof aliased === "string") return hostFromSuffix(aliased, protocol);

  const domain = s.replace(/^\./, "");
  const labels = domain.split(".");
  if (domain.length > 253 || labels.length < 2 || labels.some((label) => !SITE_NAME_RE.test(label))) {
    throw new Error(invalidHostMessage(raw));
  }
  const suffix = domain.endsWith(PRODUCTION_SUFFIX) ? PRODUCTION_SUFFIX : `.${domain}`;
  return hostFromSuffix(suffix, protocol);
}

/** Like parseHost, but returns null on invalid input. */
export function tryParseHost(raw: string): ApiHost | null {
  try {
    return parseHost(raw);
  } catch {
    return null;
  }
}

export function invalidHostMessage(raw: string): string {
  return (
    `Invalid API host ${JSON.stringify(raw)}. ` +
    `Use chargebee.com or a valid custom domain suffix over HTTPS.`
  );
}

/** A site name is exactly one DNS label (RFC 1123): `acme-test`, never `acme.chargebee.com`. */
const SITE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function invalidSiteNameMessage(raw: string): string {
  return `Invalid site name '${raw}'. Use only the subdomain, e.g. acme-test.`;
}

/**
 * Validate a site name and return it normalised (trimmed, lower-case).
 *
 * The SDK builds `new URL(path, "https://" + site + suffix)`, so any `#`, `?`,
 * `/` or `@` in the site would terminate the authority and send the API key to a
 * host other than the configured host. Every place a site enters (flags, env, profile
 * files) must go through this before a client or URL is built.
 */
export function assertValidSiteName(raw: string): string {
  const site = raw.trim().toLowerCase();
  if (!SITE_NAME_RE.test(site)) {
    throw new Error(invalidSiteNameMessage(raw));
  }
  return site;
}

/**
 * Split a site argument that may be a bare name, a `{site}.{host}` hostname,
 * or a full URL. Host is only returned when the input actually contained one.
 * The returned `site` is always a validated, lower-case DNS label.
 */
export function parseSiteInput(input: string): { site: string; hostFromInput?: ApiHost } {
  const trimmed = input.trim();
  if (/^http:\/\//i.test(trimmed)) throw new Error("Only HTTPS is supported for API hosts.");
  let s = trimmed.replace(/^https?:\/\//i, "");
  s = s.replace(/\/.*$/, "");
  s = s.replace(/:\d+$/, "");
  if (!s.includes(".")) return { site: assertValidSiteName(s) };

  const site = s.split(".")[0] ?? s;
  const host = s.toLowerCase().endsWith(PRODUCTION_SUFFIX) ? tryParseHost(s) : null;
  if (host) return { site: assertValidSiteName(site), hostFromInput: host };
  // Not a known Chargebee host: the whole string must then be a bare site name,
  // which a dotted value never is.
  throw new Error(invalidSiteNameMessage(input));
}

/** Suffix without the leading dot (never includes a scheme). */
export function displayHost(host: ApiHost): string {
  return host.suffix.replace(/^\./, "");
}

/**
 * Host value for `--host`, profile `host`, and `setHostOverride`.
 * HTTPS hosts are persisted without a scheme.
 */
export function persistableHost(host: ApiHost): string {
  return displayHost(parseHost(`${host.protocol}://${host.suffix}`));
}

/** Spool label: report the environment category rather than a hostname. */
export function telemetryEnvLabel(host: ApiHost): string {
  return host.isProduction ? "production" : "non-production";
}

/**
 * Rewrite production API hosts in generated text (curl samples) to the resolved
 * host. No-op when the resolved host is already production.
 */
export function rewriteApiHostInText(text: string, site: string, host: ApiHost): string {
  if (host.isProduction) return text;
  return text.replaceAll(
    `https://${site}${PRODUCTION_SUFFIX}`,
    `${host.protocol}://${site}${host.suffix}`,
  );
}
