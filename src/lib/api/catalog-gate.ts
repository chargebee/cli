/**
 * Pure logic for the catalog-aware command filter.
 *
 * Site mode is the combination of Configuration `product_catalog_version` and
 * `chargebee_response_schema_type` (cached on the profile at `auth add` time):
 *   - v1 + plans_addons → PC1 only (e.g. `plan`/`addon`, `subscription create`)
 *   - v1 + compat|items → dual-mode (both catalogs)
 *   - v2 + any schema   → PC2 only (e.g. `item`/`item-price`, `subscription create-with-items`)
 *
 * Catalog membership of an *operation* is derived per op from the public specs.
 * We use the cached site mode to block an incompatible operation locally —
 * before any API call — instead of letting the server reject it. This is a hard
 * restriction with no override; when PCV/schema cannot be resolved we fail open
 * (never block), so older profiles and env-var credentials keep working.
 *
 * Kept separate from `sdk.ts` (a common mock target in tests) so this logic can
 * be unit-tested in isolation. `chargebee listen` uses the same resolver via
 * `isDualModeSite`.
 */
import { paint } from "../ui/color.js";

/** Which catalog an operation belongs to. `both` operations are never gated. */
export type CatalogTag = "pc1" | "pc2" | "both";

/** What the connected site actually supports. */
export type SiteCatalog = "pc1" | "pc2" | "both";

/**
 * Map cached PCV + schema type to the catalog a site supports.
 * Returns `undefined` when the combination is missing or unrecognised, which the
 * caller treats as "unknown ⇒ fail open".
 *
 * v2 + anything (including a missing schema) is PC2-only.
 * v1 requires a recognised schema: `plans_addons` = PC1, `compat`/`items` = dual.
 */
export function siteCatalogFrom(pcv?: string, schema?: string): SiteCatalog | undefined {
  const v = (pcv ?? "").trim().toLowerCase();
  const s = (schema ?? "").trim().toLowerCase();
  if (v === "v2") return "pc2";
  if (v === "v1") {
    if (s === "plans_addons") return "pc1";
    if (s === "compat" || s === "items") return "both";
  }
  return undefined;
}

/**
 * Pure decision: should this operation be blocked on a site with the given
 * cached PCV + schema?
 *
 * - `both` operations are always allowed.
 * - Dual-mode and unknown sites never block (both allowed / fail open).
 * - Otherwise block when the operation's catalog differs from the site's.
 */
export function shouldBlockCatalog(
  pcv: string | undefined,
  schema: string | undefined,
  opCatalog: CatalogTag,
): boolean {
  if (opCatalog === "both") return false;
  const siteCatalog = siteCatalogFrom(pcv, schema);
  if (siteCatalog === undefined || siteCatalog === "both") return false;
  return siteCatalog !== opCatalog;
}

/** Human label for an exclusive operation/site catalog. */
function catalogLabel(catalog: "pc1" | "pc2"): string {
  return catalog === "pc1" ? "Product Catalog 1.0 (PC1)" : "Product Catalog 2.0 (PC2)";
}

/** Status/connect line for the resolved site mode. */
export function siteCatalogStatusLabel(pcv?: string, schema?: string): string | undefined {
  const site = siteCatalogFrom(pcv, schema);
  if (site === "pc1") return "Product Catalog 1.0";
  if (site === "pc2") return "Product Catalog 2.0";
  if (site === "both") return "Product Catalog 1.0 + 2.0 (dual-mode)";
  return undefined;
}

/** The message shown when an operation is blocked for the site's catalog. */
export function blockedCatalogMessage(
  commandName: string,
  opCatalog: "pc1" | "pc2",
  pcv: string | undefined,
  schema: string | undefined,
): string {
  const siteCatalog = siteCatalogFrom(pcv, schema);
  const siteLabel = siteCatalog === "pc1" || siteCatalog === "pc2" ? catalogLabel(siteCatalog) : "a different product catalog";
  const useInstead =
    opCatalog === "pc2"
      ? "Use PC1 operations instead: 'plan', 'addon', 'subscription create' (with plan_id)."
      : "Use PC2 operations instead: 'item', 'item-price', 'item-family', 'subscription create-with-items'.";
  return (
    `${paint("31", "✗")} '${commandName}' is a ${catalogLabel(opCatalog)} operation and isn't available on your site.\n\n` +
    `  Your site uses ${siteLabel}.\n` +
    `  ${useInstead}\n` +
    "  Tip: run 'chargebee auth status' to confirm your catalog version.\n"
  );
}
