import { describe, expect, it } from "bun:test";
import {
  PRODUCTION_HOST,
  assertValidSiteName,
  displayHost,
  parseHost,
  parseSiteInput,
  persistableHost,
  rewriteApiHostInText,
  telemetryEnvLabel,
  tryParseHost,
} from "../../../../lib/config/host.js";

describe("parseHost", () => {
  it("defaults-style aliases resolve to production", () => {
    for (const input of ["production", "PROD", "chargebee.com", ".chargebee.com"]) {
      const host = parseHost(input);
      expect(host.suffix).toBe(".chargebee.com");
      expect(host.isProduction).toBe(true);
      expect(host.protocol).toBe("https");
    }
  });

  it("accepts custom suffixes including multiple labels", () => {
    expect(parseHost("api.example.com").suffix).toBe(".api.example.com");
  });

  it("strips the site label from a full host", () => {
    expect(parseHost("acme-test.example.com").suffix).toBe(".acme-test.example.com");
    expect(parseHost("acme.example.com").suffix).toBe(".acme.example.com");
    expect(parseHost("acme.chargebee.com").suffix).toBe(".chargebee.com");
    expect(parseHost("https://example.com/api/v2").suffix).toBe(".example.com");
  });



  it("rejects http:// for production and remote Chargebee hosts", () => {
    expect(() => parseHost("http://chargebee.com")).toThrow(/Only HTTPS is supported/);
    expect(() => parseHost("http://acme.chargebee.com")).toThrow(/Only HTTPS is supported/);
  });

  it("rejects empty or unknown single-label values", () => {
    expect(() => parseHost("")).toThrow(/Invalid API host/);
    expect(() => parseHost("staging")).toThrow(/Invalid API host/);
    expect(tryParseHost("staging")).toBeNull();
  });

  it("rejects malformed domain suffixes", () => {
    for (const value of ["a..com", "user@example.com", "example.com#", "-bad.com"]) {
      expect(() => parseHost(value)).toThrow(/Invalid API host/);
    }
  });

  it("names only the public chargebee.com host in the rejection message", () => {
    let message = "";
    try {
      parseHost("invalid");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("chargebee.com");
    expect(message).toContain("Use chargebee.com");
  });
});

describe("parseSiteInput", () => {
  it("passes a bare site name through", () => {
    expect(parseSiteInput("acme-test")).toEqual({ site: "acme-test" });
  });

  it("extracts site + host from a full URL", () => {
    const parsed = parseSiteInput("https://acme-test.chargebee.com");
    expect(parsed.site).toBe("acme-test");
    expect(parsed.hostFromInput?.suffix).toBe(".chargebee.com");
  });



  it("rejects http:// site URLs for remote hosts", () => {
    expect(() => parseSiteInput("http://acme.chargebee.com")).toThrow(
      /Only HTTPS is supported/,
    );
  });

  it("extracts host from {site}.chargebee.com", () => {
    const parsed = parseSiteInput("globex.chargebee.com");
    expect(parsed.site).toBe("globex");
    expect(parsed.hostFromInput?.isProduction).toBe(true);
  });

  it("normalises the site label to lower-case", () => {
    expect(parseSiteInput("ACME-Test").site).toBe("acme-test");
    expect(parseSiteInput("ACME-Test.CHARGEBEE.COM").site).toBe("acme-test");
    expect(parseSiteInput("  acme-test  ").site).toBe("acme-test");
  });

  it("rejects site strings that would break out of the host allowlist", () => {
    for (const input of ["evil.com#", "evil.com?", "evil.com/", "user@evil.com", "evil.com", "a b", ""]) {
      expect(() => parseSiteInput(input)).toThrow(/Invalid site name/);
    }
  });
});

describe("assertValidSiteName", () => {
  it("accepts DNS-label site names and lower-cases them", () => {
    expect(assertValidSiteName("acme-test")).toBe("acme-test");
    expect(assertValidSiteName("ACME-Test")).toBe("acme-test");
    expect(assertValidSiteName("a")).toBe("a");
    expect(assertValidSiteName("a1-b2")).toBe("a1-b2");
  });

  it("rejects anything that is not a single DNS label", () => {
    for (const input of [
      "evil.com#",
      "evil.com?",
      "evil.com/",
      "user@evil.com",
      "acme-test.chargebee.com",
      "-acme",
      "acme-",
      "acme test",
      "acme:443",
      "",
      "a".repeat(64),
    ]) {
      expect(() => assertValidSiteName(input)).toThrow(
        `Invalid site name '${input}'. Use only the subdomain, e.g. acme-test.`,
      );
    }
  });
});

describe("display + telemetry helpers", () => {
  it("strips the leading dot for display", () => {
    expect(displayHost(PRODUCTION_HOST)).toBe("chargebee.com");
    expect(displayHost(parseHost("example.com"))).toBe("example.com");
  });

  it("persists HTTPS custom hosts without a scheme", () => {
    expect(persistableHost(parseHost("example.com"))).toBe("example.com");
  });

  it("redacts non-production hosts for telemetry", () => {
    expect(telemetryEnvLabel(PRODUCTION_HOST)).toBe("production");
    expect(telemetryEnvLabel(parseHost("example.com"))).toBe("non-production");
  });

  it("rewrites production URLs in generated samples", () => {
    const host = parseHost("example.com");
    const sample = "curl https://acme-test.chargebee.com/api/v2/customers";
    expect(rewriteApiHostInText(sample, "acme-test", host)).toBe(
      "curl https://acme-test.example.com/api/v2/customers",
    );
    expect(rewriteApiHostInText(sample, "acme-test", PRODUCTION_HOST)).toBe(sample);
  });
});
