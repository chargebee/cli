import { describe, expect, it } from "bun:test";

import {
  blockedCatalogMessage,
  shouldBlockCatalog,
  siteCatalogFrom,
  siteCatalogStatusLabel,
} from "../../../../lib/api/catalog-gate.js";

describe("siteCatalogFrom", () => {
  it("is PC1 only when v1 + plans_addons", () => {
    expect(siteCatalogFrom("v1", "plans_addons")).toBe("pc1");
    expect(siteCatalogFrom("V1", "  PLANS_ADDONS ")).toBe("pc1");
  });

  it("is dual-mode when v1 + compat or items", () => {
    expect(siteCatalogFrom("v1", "compat")).toBe("both");
    expect(siteCatalogFrom("v1", "items")).toBe("both");
    expect(siteCatalogFrom("V1", "COMPAT")).toBe("both");
  });

  it("is PC2 only for any v2 schema, including missing", () => {
    expect(siteCatalogFrom("v2", "items")).toBe("pc2");
    expect(siteCatalogFrom("v2", "plans_addons")).toBe("pc2");
    expect(siteCatalogFrom("v2", "compat")).toBe("pc2");
    expect(siteCatalogFrom("v2", undefined)).toBe("pc2");
    expect(siteCatalogFrom("v2", "")).toBe("pc2");
  });

  it("returns undefined when PCV/schema cannot be resolved", () => {
    expect(siteCatalogFrom(undefined, "compat")).toBeUndefined();
    expect(siteCatalogFrom("v1", undefined)).toBeUndefined();
    expect(siteCatalogFrom("v1", "unknown")).toBeUndefined();
    expect(siteCatalogFrom()).toBeUndefined();
  });
});

describe("shouldBlockCatalog", () => {
  it("never blocks catalog-neutral operations", () => {
    expect(shouldBlockCatalog("v1", "plans_addons", "both")).toBe(false);
    expect(shouldBlockCatalog("v2", "items", "both")).toBe(false);
    expect(shouldBlockCatalog(undefined, undefined, "both")).toBe(false);
  });

  it("blocks PC2 ops on a PC1-only site", () => {
    expect(shouldBlockCatalog("v1", "plans_addons", "pc2")).toBe(true);
  });

  it("blocks PC1 ops on a PC2-only site, including v2 + compat", () => {
    expect(shouldBlockCatalog("v2", "items", "pc1")).toBe(true);
    expect(shouldBlockCatalog("v2", "compat", "pc1")).toBe(true);
    expect(shouldBlockCatalog("v2", "plans_addons", "pc1")).toBe(true);
  });

  it("allows matching exclusive catalogs", () => {
    expect(shouldBlockCatalog("v1", "plans_addons", "pc1")).toBe(false);
    expect(shouldBlockCatalog("v2", "items", "pc2")).toBe(false);
    expect(shouldBlockCatalog("v2", "compat", "pc2")).toBe(false);
  });

  it("never blocks on dual-mode (v1 + compat|items)", () => {
    expect(shouldBlockCatalog("v1", "compat", "pc1")).toBe(false);
    expect(shouldBlockCatalog("v1", "compat", "pc2")).toBe(false);
    expect(shouldBlockCatalog("v1", "items", "pc1")).toBe(false);
    expect(shouldBlockCatalog("v1", "items", "pc2")).toBe(false);
  });

  it("fails open when the catalog is unknown", () => {
    expect(shouldBlockCatalog(undefined, "plans_addons", "pc2")).toBe(false);
    expect(shouldBlockCatalog("v1", undefined, "pc2")).toBe(false);
    expect(shouldBlockCatalog("v1", "mystery", "pc2")).toBe(false);
  });
});

describe("siteCatalogStatusLabel", () => {
  it("names exclusive and dual-mode sites", () => {
    expect(siteCatalogStatusLabel("v1", "plans_addons")).toBe("Product Catalog 1.0");
    expect(siteCatalogStatusLabel("v2", "items")).toBe("Product Catalog 2.0");
    expect(siteCatalogStatusLabel("v2", "compat")).toBe("Product Catalog 2.0");
    expect(siteCatalogStatusLabel("v1", "compat")).toBe("Product Catalog 1.0 + 2.0 (dual-mode)");
    expect(siteCatalogStatusLabel("v1", "items")).toBe("Product Catalog 1.0 + 2.0 (dual-mode)");
    expect(siteCatalogStatusLabel("v1", undefined)).toBeUndefined();
  });
});

describe("blockedCatalogMessage", () => {
  it("names the blocked resource and the right alternatives for a PC1 site", () => {
    const msg = blockedCatalogMessage("item", "pc2", "v1", "plans_addons");
    expect(msg).toContain("'item'");
    expect(msg).toContain("Product Catalog 2.0 (PC2)");
    expect(msg).toContain("Your site uses Product Catalog 1.0 (PC1)");
    expect(msg).toContain("'plan', 'addon'");
    expect(msg).toContain("auth status");
  });

  it("names the right alternatives for a PC2 site, including v2 + compat", () => {
    const msg = blockedCatalogMessage("plan", "pc1", "v2", "compat");
    expect(msg).toContain("'plan'");
    expect(msg).toContain("Your site uses Product Catalog 2.0 (PC2)");
    expect(msg).toContain("'item', 'item-price'");
  });
});
