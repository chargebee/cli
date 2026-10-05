import { siteCatalogFrom } from "../api/catalog-gate.js";

/** Select live assertions from auth add's persisted metadata, never a fixture's slot number. */
export function liveCatalogChecks(version?: string, schema?: string) {
  const catalog = siteCatalogFrom(version, schema);
  if (!catalog) throw new Error("Configure did not detect a supported product catalog; refusing to skip catalog assertions");
  return {
    catalog,
    allowed: catalog === "both" ? ["plan", "item"] : [catalog === "pc1" ? "plan" : "item"],
    blocked: catalog === "both" ? [] : [catalog === "pc1" ? "item" : "plan"],
  };
}
