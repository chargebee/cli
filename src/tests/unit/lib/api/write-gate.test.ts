import { describe, expect, it } from "bun:test";

import {
  blockedWriteMessage,
  isLiveSite,
  isReadOnlyOperation,
  isWriteMethod,
  shouldBlockWrite,
  siteMode,
} from "../../../../lib/api/write-gate.js";

describe("isLiveSite", () => {
  it("treats a site name ending in -test as a test site", () => {
    expect(isLiveSite("acme-test")).toBe(false);
    expect(isLiveSite("acme-TEST")).toBe(false);
  });

  it("treats any other site name as live", () => {
    expect(isLiveSite("acme")).toBe(true);
    expect(isLiveSite("acme-prod")).toBe(true);
    expect(isLiveSite("acme-testing")).toBe(true); // only the exact -test suffix counts
  });

  it("gives the site name precedence over the key prefix", () => {
    // A -test site name wins even if the key looks live.
    expect(isLiveSite("acme-test", "live_abc")).toBe(false);
  });

  it("uses the key prefix only as a secondary signal (non -test site)", () => {
    expect(isLiveSite("acme", "test_abc")).toBe(false); // test_ key marks a test site
    expect(isLiveSite("acme", "live_abc")).toBe(true);
    expect(isLiveSite("acme")).toBe(true); // no key → default live
  });
});

describe("siteMode", () => {
  it("returns test or live using the same rules as isLiveSite", () => {
    expect(siteMode("acme-test", "live_abc")).toBe("test");
    expect(siteMode("acme", "test_abc")).toBe("test");
    expect(siteMode("acme", "live_abc")).toBe("live");
  });
});

describe("isWriteMethod", () => {
  it("treats GET as a read", () => {
    expect(isWriteMethod("GET")).toBe(false);
    expect(isWriteMethod("get")).toBe(false);
  });
  it("treats everything else as a write", () => {
    expect(isWriteMethod("POST")).toBe(true);
    expect(isWriteMethod("PUT")).toBe(true);
    expect(isWriteMethod("DELETE")).toBe(true);
  });
});

describe("shouldBlockWrite", () => {
  it("never blocks reads", () => {
    expect(shouldBlockWrite({ method: "GET", site: "acme" })).toBe(false);
  });

  it("never blocks writes on test sites", () => {
    expect(shouldBlockWrite({ method: "POST", site: "acme-test" })).toBe(false);
  });

  it("always blocks writes on live sites (hard cap, no override)", () => {
    expect(shouldBlockWrite({ method: "POST", site: "acme" })).toBe(true);
    expect(shouldBlockWrite({ method: "DELETE", site: "acme" })).toBe(true);
    expect(shouldBlockWrite({ method: "PUT", site: "acme" })).toBe(true);
  });

  it("respects key-prefix override (test_ key on a live-named site)", () => {
    expect(shouldBlockWrite({ method: "POST", site: "acme", apiKey: "test_x" })).toBe(false);
  });

  it("blocks writes on a -test-named site only when the name says test", () => {
    // -test name → test → allowed regardless of key.
    expect(shouldBlockWrite({ method: "POST", site: "acme-test", apiKey: "live_x" })).toBe(false);
  });
});

describe("isReadOnlyOperation", () => {
  it("allows every estimate operation regardless of action", () => {
    expect(isReadOnlyOperation("estimate.createSubscription")).toBe(true);
    expect(isReadOnlyOperation("estimate.updateSubscription")).toBe(true);
  });

  it("allows every export operation", () => {
    expect(isReadOnlyOperation("export.customers")).toBe(true);
  });

  it("allows hosted-page URL generation but not the hosted-page state writes", () => {
    expect(isReadOnlyOperation("hostedPage.checkoutNew")).toBe(true);
    expect(isReadOnlyOperation("hostedPage.retrieveAgreementPdf")).toBe(true);
    expect(isReadOnlyOperation("hostedPage.acknowledge")).toBe(false);
    expect(isReadOnlyOperation("hostedPage.events")).toBe(false);
  });

  it("allows only portalSession.create, not other portal session actions", () => {
    expect(isReadOnlyOperation("portalSession.create")).toBe(true);
    expect(isReadOnlyOperation("portalSession.activate")).toBe(false);
    expect(isReadOnlyOperation("portalSession.logout")).toBe(false);
  });

  it("allows actions whose name starts with a read-only verb", () => {
    expect(isReadOnlyOperation("inAppSubscription.retrieveStoreSubs")).toBe(true);
    expect(isReadOnlyOperation("quote.retrieveSignedPdf")).toBe(true);
  });

  it("does not match a prefix that is only a substring of the action name", () => {
    // "checkoutNew" contains "check" but is not a read-only-style verb.
    expect(isReadOnlyOperation("hostedPage.checkoutNew")).toBe(true); // allowed via the resource rule, not the prefix rule
    expect(isReadOnlyOperation("subscription.checkoutNew")).toBe(false);
  });

  it("blocks ordinary mutating operations", () => {
    expect(isReadOnlyOperation("customer.create")).toBe(false);
    expect(isReadOnlyOperation("subscription.update")).toBe(false);
    expect(isReadOnlyOperation("customer.delete")).toBe(false);
  });

  it("is false without an operation key", () => {
    expect(isReadOnlyOperation()).toBe(false);
    expect(isReadOnlyOperation("")).toBe(false);
  });
});

describe("generated write gate emission (resource+action allowlist)", () => {
  // Mirrors the decision generate.ts makes: a POST/PUT/DELETE op is only
  // gated when it is a write AND not on the read-only allowlist.
  function isGated(method: string, operationKey: string): boolean {
    return isWriteMethod(method) && !isReadOnlyOperation(operationKey);
  }

  it("estimate create is never gated, even conceptually on a live site", () => {
    expect(isGated("POST", "estimate.createSubscription")).toBe(false);
  });

  it("customer create stays gated (blocked on live, allowed on test site)", () => {
    expect(isGated("POST", "customer.create")).toBe(true);
    expect(shouldBlockWrite({ method: "POST", site: "acme" })).toBe(true);
    expect(shouldBlockWrite({ method: "POST", site: "acme-test" })).toBe(false);
  });
});

describe("blockedWriteMessage", () => {
  it("names the site and explains the restriction", () => {
    const msg = blockedWriteMessage("acme");
    expect(msg).toContain('live site "acme"');
    expect(msg).toContain("read-only");
    expect(msg).toContain("name ending in \"-test\", or a test_ API key");
  });
});
