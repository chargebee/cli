import { expect, it } from "bun:test";
import { liveCatalogChecks } from "../../../lib/test-support/live-catalog.js";

it("accepts two PC2 fixtures while keeping PC1-operation refusal checks", () => {
  for (const schema of ["items", "compat"]) {
    expect(liveCatalogChecks("v2", schema)).toEqual({ catalog: "pc2", allowed: ["item"], blocked: ["plan"] });
  }
});

it("checks the inverse gate on a PC1-only fixture", () => {
  expect(liveCatalogChecks("v1", "plans_addons")).toEqual({ catalog: "pc1", allowed: ["plan"], blocked: ["item"] });
});

it("permits both resource families on dual-mode fixtures", () => {
  for (const schema of ["compat", "items"]) {
    expect(liveCatalogChecks("v1", schema)).toEqual({ catalog: "both", allowed: ["plan", "item"], blocked: [] });
  }
});

it("fails on missing or unsupported catalog metadata instead of silently dropping assertions", () => {
  for (const [version, schema] of [[undefined, undefined], ["v1", undefined], ["v3", "items"]]) {
    expect(() => liveCatalogChecks(version, schema)).toThrow("supported product catalog");
  }
});
