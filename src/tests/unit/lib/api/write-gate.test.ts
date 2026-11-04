import { describe, expect, it } from "bun:test";

import {
  isLiveSite,
  isReadOnlyOperation,
  isWriteMethod,
  liveWriteDecision,
  liveWriteNotice,
  liveWritePrompt,
  siteMode,
  unconfirmedWriteMessage,
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

describe("liveWriteDecision", () => {
  const decide = (o: { method?: string; site?: string; apiKey?: string; yes?: boolean; canPrompt?: boolean }) =>
    liveWriteDecision({ method: "POST", site: "acme", yes: false, canPrompt: false, ...o });

  it("allows reads on any site, with or without a terminal", () => {
    expect(decide({ method: "GET" })).toBe("allow");
    expect(decide({ method: "GET", canPrompt: true })).toBe("allow");
  });

  it("allows writes on test sites without confirmation", () => {
    expect(decide({ site: "acme-test" })).toBe("allow");
    expect(decide({ site: "acme-test", apiKey: "live_x" })).toBe("allow");
    expect(decide({ site: "acme", apiKey: "test_x" })).toBe("allow");
    expect(decide({ site: "acme-test", yes: true })).toBe("allow");
  });

  it("asks for confirmation on a live site when a prompt is possible", () => {
    expect(decide({ canPrompt: true })).toBe("confirm");
    expect(decide({ method: "DELETE", canPrompt: true })).toBe("confirm");
  });

  it("refuses a live-site write that cannot be confirmed", () => {
    expect(decide({})).toBe("refuse");
    expect(decide({ method: "PUT" })).toBe("refuse");
  });

  it("runs a live-site write confirmed with --yes, prompt or not", () => {
    expect(decide({ yes: true })).toBe("allow_live");
    expect(decide({ yes: true, canPrompt: true })).toBe("allow_live");
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

  it("customer create stays gated (confirmed on live, allowed on test site)", () => {
    expect(isGated("POST", "customer.create")).toBe(true);
    expect(liveWriteDecision({ method: "POST", site: "acme", yes: false, canPrompt: false })).toBe("refuse");
    expect(liveWriteDecision({ method: "POST", site: "acme-test", yes: false, canPrompt: false })).toBe("allow");
  });
});

describe("live-site write messages", () => {
  it("refusal names the site and command and explains --yes", () => {
    const msg = unconfirmedWriteMessage("acme", "customer create");
    expect(msg).toContain('Refusing to run a write operation on live site "acme"');
    expect(msg).toContain('"customer create"');
    expect(msg).toContain("--yes");
    expect(msg).toContain("name ending in \"-test\", or a test_ API key");
  });

  it("prompt names the site and command", () => {
    expect(liveWritePrompt("acme", "customer create")).toBe(
      'Run "customer create" on LIVE site "acme"? This changes production data.',
    );
  });

  it("notice names the site", () => {
    expect(liveWriteNotice("acme")).toContain('Writing to live site "acme"');
  });
});
