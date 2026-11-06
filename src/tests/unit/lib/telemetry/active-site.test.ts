import { afterEach, describe, expect, it } from "bun:test";

import { noteActiveSite, takeActiveSite } from "../../../../lib/telemetry/active-site.js";

afterEach(() => {
  takeActiveSite();
});

describe("active-site slot", () => {
  it("is empty by default", () => {
    expect(takeActiveSite()).toBeUndefined();
  });

  it("returns the noted site once, then clears", () => {
    noteActiveSite("acme-test");
    expect(takeActiveSite()).toBe("acme-test");
    expect(takeActiveSite()).toBeUndefined();
  });

  it("keeps the latest noted site", () => {
    noteActiveSite("acme-test");
    noteActiveSite("globex-test");
    expect(takeActiveSite()).toBe("globex-test");
  });
});
