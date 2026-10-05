import { describe, expect, it } from "bun:test";

import { isDualModeSite } from "../../../../lib/tunnel/dual-mode.js";

describe("isDualModeSite", () => {
  it("is exclusive PCV1 when v1 + plans_addons", () => {
    expect(isDualModeSite("v1", "plans_addons")).toBe(false);
  });

  it("is dual-mode when v1 + compat or items", () => {
    expect(isDualModeSite("v1", "compat")).toBe(true);
    expect(isDualModeSite("v1", "items")).toBe(true);
    expect(isDualModeSite("V1", "COMPAT")).toBe(true);
  });

  it("is exclusive PCV2 for any v2 schema", () => {
    expect(isDualModeSite("v2", "items")).toBe(false);
    expect(isDualModeSite("v2", "plans_addons")).toBe(false);
    expect(isDualModeSite("v2", "compat")).toBe(false);
  });

  it("does not guess dual-mode when either field is missing", () => {
    expect(isDualModeSite(undefined, "compat")).toBe(false);
    expect(isDualModeSite("v1", undefined)).toBe(false);
    expect(isDualModeSite()).toBe(false);
    expect(isDualModeSite("v1", "unknown")).toBe(false);
  });
});
