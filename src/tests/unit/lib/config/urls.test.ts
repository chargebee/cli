import { describe, expect, it } from "bun:test";
import { parseHost } from "../../../../lib/config/host.js";
import {
  apiBaseURL,
  appsyncEndpoints,
  appsyncUnavailableMessage,
  endpointsFromDnsPrefix,
  __setAppsyncTableForTest,
} from "../../../../lib/config/urls.js";

describe("urls", () => {
  it("builds API base URLs on chargebee.com by default", () => {
    expect(apiBaseURL("acme")).toBe("https://acme.chargebee.com");
    expect(apiBaseURL("test-site")).toBe("https://test-site.chargebee.com");
  });

  it("builds API base URLs for non-production hosts", () => {
    expect(apiBaseURL("acme", parseHost("https://example.com"))).toBe("https://acme.example.com");
  });

  it("refuses to build a URL for a site that is not a DNS label", () => {
    for (const site of ["evil.com#", "evil.com?", "evil.com/", "user@evil.com"]) {
      expect(() => apiBaseURL(site)).toThrow(/Invalid site name/);
    }
  });

  it("derives AppSync HTTP and realtime hostnames from dns prefix + region", () => {
    expect(endpointsFromDnsPrefix("abc123", "us-east-2")).toEqual({
      httpDomain: "abc123.appsync-api.us-east-2.amazonaws.com",
      realtimeDomain: "abc123.appsync-realtime-api.us-east-2.amazonaws.com",
    });
  });

  it("resolves production AppSync endpoints in each region", () => {
    expect(appsyncEndpoints(parseHost("chargebee.com"), "us")).toEqual(
      endpointsFromDnsPrefix("7aq2lm52z5dznchdofjdzko54q", "us-east-1"),
    );
    expect(appsyncEndpoints(parseHost("chargebee.com"), "eu")).toEqual(
      endpointsFromDnsPrefix("ik6gefqr7jb6nnqxkwszgybxpm", "eu-central-1"),
    );
    expect(appsyncEndpoints(parseHost("chargebee.com"), "au")).toEqual(
      endpointsFromDnsPrefix("7yma4y4xifa4hj53g6go6rnk3e", "ap-southeast-2"),
    );
  });

  it("has no AppSync endpoints for local development", () => {
    for (const region of ["us", "eu", "au"] as const) {
      expect(appsyncEndpoints(parseHost("example.com"), region)).toBeNull();
    }
  });

  it("resolves endpoints from a test-injected table and fails closed on empty prefixes", () => {
    try {
      __setAppsyncTableForTest({
        ".chargebee.com": { us: { dnsPrefix: "testid", region: "us-east-2" } },
      });
      expect(appsyncEndpoints(parseHost("chargebee.com"), "us")).toEqual({
        httpDomain: "testid.appsync-api.us-east-2.amazonaws.com",
        realtimeDomain: "testid.appsync-realtime-api.us-east-2.amazonaws.com",
      });

      __setAppsyncTableForTest({
        ".chargebee.com": { us: { dnsPrefix: "", region: "us-east-1" } },
      });
      expect(appsyncEndpoints(parseHost("chargebee.com"), "us")).toBeNull();
    } finally {
      __setAppsyncTableForTest(null);
    }
  });

  it("picks the AppSync deployment for the requested region", () => {
    try {
      __setAppsyncTableForTest({
        ".chargebee.com": {
          us: { dnsPrefix: "usid", region: "us-east-1" },
          eu: { dnsPrefix: "euid", region: "eu-central-1" },
        },
      });
      expect(appsyncEndpoints(parseHost("chargebee.com"), "eu")).toEqual({
        httpDomain: "euid.appsync-api.eu-central-1.amazonaws.com",
        realtimeDomain: "euid.appsync-realtime-api.eu-central-1.amazonaws.com",
      });
      // An undeployed region resolves to no endpoint, not another region's.
      expect(appsyncEndpoints(parseHost("chargebee.com"), "au")).toBeNull();
    } finally {
      __setAppsyncTableForTest(null);
    }
  });

  it("names the deployed regions when the requested one is missing", () => {
    try {
      __setAppsyncTableForTest({
        ".chargebee.com": {
          us: { dnsPrefix: "usid", region: "us-east-1" },
          eu: { dnsPrefix: "euid", region: "eu-central-1" },
        },
      });
      const msg = appsyncUnavailableMessage(parseHost("chargebee.com"), "au");
      expect(msg).toContain('"au"');
      expect(msg).toContain("Available: us, eu");
      expect(msg).toContain("--region");
    } finally {
      __setAppsyncTableForTest(null);
    }
  });

  it("falls back to the environment-wide message when no region is deployed", () => {
    try {
      __setAppsyncTableForTest({});
      expect(appsyncUnavailableMessage(parseHost("chargebee.com"), "us")).toBe(
        "Webhook tunneling is not available for this environment yet.",
      );
    } finally {
      __setAppsyncTableForTest(null);
    }
  });
});
