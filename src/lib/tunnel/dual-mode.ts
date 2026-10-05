import { siteCatalogFrom } from "../api/catalog-gate.js";

export function isDualModeSite(pcv?: string, schema?: string): boolean {
  return siteCatalogFrom(pcv, schema) === "both";
}
