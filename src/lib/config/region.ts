/**
 * Chargebee region: the geography a site's data is hosted in.
 *
 * Part of a profile's configuration, and not derivable from an API URL — every
 * region shares the same host suffix in production.
 *
 * The region selects the regional webhook tunnel endpoint. API requests are
 * region-agnostic (`https://{site}{suffix}`).
 */

export const REGIONS = ["us", "eu", "au"] as const;

export type Region = (typeof REGIONS)[number];

export const DEFAULT_REGION: Region = "us";

/** Human label for prompts and help text. */
const REGION_LABELS: Record<Region, string> = {
  us: "United States",
  eu: "Europe",
  au: "Australia",
};

export function regionLabel(region: Region): string {
  return REGION_LABELS[region];
}

export function invalidRegionMessage(raw: string): string {
  return `Invalid region ${JSON.stringify(raw)}. Use one of: ${REGIONS.join(", ")}.`;
}

/**
 * Parse a user/env/profile region value. Accepts any case with surrounding
 * whitespace, and rejects everything that is not one of {@link REGIONS}.
 */
export function parseRegion(raw: string): Region {
  const value = raw.trim().toLowerCase();
  if ((REGIONS as readonly string[]).includes(value)) {
    return value as Region;
  }
  throw new Error(invalidRegionMessage(raw));
}
