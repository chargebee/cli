import { PRODUCTION_HOST, assertValidSiteName, type ApiHost } from "./host.js";
import { REGIONS, type Region } from "./region.js";

/**
 * API base URL for a site: `{protocol}://{site}{suffix}`. Defaults to production.
 * Throws on a site that is not a plain DNS label (see `assertValidSiteName`).
 */
export function apiBaseURL(site: string, host: ApiHost = PRODUCTION_HOST): string {
  return `${host.protocol}://${assertValidSiteName(site)}${host.suffix}`;
}

/** AppSync Events API endpoints for the webhook tunnel. */
export interface AppSyncEndpoints {
  /** e.g. xxxx.appsync-api.us-east-2.amazonaws.com */
  httpDomain: string;
  /** e.g. xxxx.appsync-realtime-api.us-east-2.amazonaws.com */
  realtimeDomain: string;
}

/** One deployed AppSync Events API: its DNS prefix and the AWS region hosting it. */
export interface AppSyncApi {
  /** Generated endpoint prefix, e.g. `exampleprefix`. */
  dnsPrefix: string;
  /** AWS region the API lives in, e.g. `us-east-2`. */
  region: string;
}

/**
 * Hardcoded AppSync Events API per Chargebee host suffix and region — each
 * region has its own deployment.
 *
 * Outer key is the public API host suffix; inner key is the Chargebee region.
 *
 * A region is reachable only through its own deployment, so an absent suffix or
 * region resolves to no endpoint rather than to another region's.
 *
 * The prefix is generated independently of the AppSync API id and cannot be
 * derived from it; `appsync_event_api_id` belongs in ARNs, never in a hostname.
 */
const APPSYNC_BY_SUFFIX: Record<string, Partial<Record<Region, AppSyncApi>>> = {
  ".chargebee.com": {
    us: { dnsPrefix: "7aq2lm52z5dznchdofjdzko54q", region: "us-east-1" },
    eu: { dnsPrefix: "ik6gefqr7jb6nnqxkwszgybxpm", region: "eu-central-1" },
    au: { dnsPrefix: "7yma4y4xifa4hj53g6go6rnk3e", region: "ap-southeast-2" },
  },
};

let appsyncTable = APPSYNC_BY_SUFFIX;

/** TEST-ONLY: replace the hardcoded AppSync table (pass null to restore). */
export function __setAppsyncTableForTest(
  table: Record<string, Partial<Record<Region, AppSyncApi>>> | null,
): void {
  appsyncTable = table ?? APPSYNC_BY_SUFFIX;
}

/** Derive HTTP + realtime hostnames from a hardcoded AppSync DNS prefix + region. */
export function endpointsFromDnsPrefix(dnsPrefix: string, region: string): AppSyncEndpoints {
  return {
    httpDomain: `${dnsPrefix}.appsync-api.${region}.amazonaws.com`,
    realtimeDomain: `${dnsPrefix}.appsync-realtime-api.${region}.amazonaws.com`,
  };
}

/**
 * AppSync Events endpoints for an API host and region, or `null` when no API is
 * deployed for that combination.
 */
export function appsyncEndpoints(host: ApiHost, region: Region): AppSyncEndpoints | null {
  const api = appsyncTable[host.suffix]?.[region];
  if (!api?.dnsPrefix || !api.region) return null;
  return endpointsFromDnsPrefix(api.dnsPrefix, api.region);
}

/**
 * Why webhook tunneling is unavailable, listing the regions this host does
 * serve so a missing deployment reads differently from a mismatched region.
 */
export function appsyncUnavailableMessage(host: ApiHost, region: Region): string {
  const deployed = REGIONS.filter((r) => appsyncTable[host.suffix]?.[r]?.dnsPrefix);
  if (deployed.length === 0) {
    return "Webhook tunneling is not available for this environment yet.";
  }
  return (
    `Webhook tunneling is not available in the "${region}" region for this environment yet.\n\n` +
    `  Available: ${deployed.join(", ")}.\n` +
    `  If the site is in one of those, re-run \`chargebee auth add --region <region>\`.`
  );
}
