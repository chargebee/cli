import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetDocsMemoForTest,
  fetchOperation,
  fetchResource,
  listOperations,
  listResources,
  parseSitemap,
  resolveOp,
  resolveSegment,
  stripControlChars,
} from "../../../../lib/docs/index.js";

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://apidocs.chargebee.com/docs/api/customers</loc></url>
  <url><loc>https://apidocs.chargebee.com/docs/api/customers/create-a-customer</loc></url>
  <url><loc>https://apidocs.chargebee.com/docs/api/customers/list-customers</loc></url>
  <url><loc>https://apidocs.chargebee.com/docs/api/customers/change-billing-date</loc></url>
  <url><loc>https://apidocs.chargebee.com/docs/api/item_prices/retrieve-an-item-price</loc></url>
  <url><loc>https://apidocs.chargebee.com/docs/api/hosted_pages/checkout-charge-items-and-one-time-charges</loc></url>
  <url><loc>https://apidocs.chargebee.com/docs/api/v1/customers/create-a-customer</loc></url>
  <url><loc>https://apidocs.chargebee.com/docs/api/v2/pcv-1/customers/list-customers</loc></url>
  <url><loc>https://apidocs.chargebee.com/docs/getting-started</loc></url>
</urlset>`;

describe("parseSitemap", () => {
  const idx = parseSitemap(SITEMAP);

  it("groups operation pages under their resource segment", () => {
    expect([...idx.resources.keys()].sort()).toEqual([
      "customers",
      "hosted_pages",
      "item_prices",
    ]);
    expect(idx.resources.get("customers")!.size).toBe(3);
  });

  it("ignores landing pages and non-api urls", () => {
    // /docs/api/customers (no op) and /docs/getting-started are excluded
    expect(idx.resources.get("customers")!.has("")).toBe(false);
  });

  it("skips versioned/legacy trees (v1, v2/pcv-1)", () => {
    // /docs/api/v1/... and /docs/api/v2/... must not create bogus resources
    expect(idx.resources.has("v1")).toBe(false);
    expect(idx.resources.has("v2")).toBe(false);
  });

  it("stores the full path for each op", () => {
    expect(idx.resources.get("customers")!.get("create-a-customer")).toBe(
      "/docs/api/customers/create-a-customer"
    );
  });
});

describe("resolveSegment", () => {
  const idx = parseSitemap(SITEMAP);

  it("maps singular CLI names to the plural sitemap segment", () => {
    expect(resolveSegment(idx, "customer")).toBe("customers");
    expect(resolveSegment(idx, "item_price")).toBe("item_prices");
  });

  it("accepts the exact segment too", () => {
    expect(resolveSegment(idx, "customers")).toBe("customers");
  });

  it("returns null for unknown resources", () => {
    expect(resolveSegment(idx, "nonexistent")).toBeNull();
  });
});

describe("resolveOp", () => {
  const ops = parseSitemap(SITEMAP).resources.get("customers")!;

  it("resolves common SDK names via kebab-prefix", () => {
    expect(resolveOp(ops, "create")).toBe("create-a-customer");
    expect(resolveOp(ops, "list")).toBe("list-customers");
  });

  it("resolves camelCase SDK names to kebab slugs", () => {
    expect(resolveOp(ops, "changeBillingDate")).toBe("change-billing-date");
  });

  it("accepts an exact doc slug", () => {
    expect(resolveOp(ops, "create-a-customer")).toBe("create-a-customer");
  });

  it("resolves non-prefix SDK names via unique token-subset", () => {
    const hp = parseSitemap(SITEMAP).resources.get("hosted_pages")!;
    // tokens {checkout,one,time,items} ⊆ {checkout,charge,items,one,time,charges}
    expect(resolveOp(hp, "checkoutOneTimeForItems")).toBe(
      "checkout-charge-items-and-one-time-charges"
    );
  });

  it("returns null when nothing matches", () => {
    expect(resolveOp(ops, "teleport")).toBeNull();
  });
});

describe("stripControlChars", () => {
  it("removes ESC and other C0 control bytes", () => {
    const withAnsi = "\x1b[31mred\x1b[0m text\x07bell";
    expect(stripControlChars(withAnsi)).toBe("[31mred[0m textbell");
  });

  it("removes C1 control bytes", () => {
    expect(stripControlChars("a\u0090b\u009fc")).toBe("abc");
  });

  it("keeps newline, tab, and carriage return", () => {
    const text = "line1\nline2\tindented\r\n";
    expect(stripControlChars(text)).toBe(text);
  });
});

describe("docs fetcher hardening (stubbed fetch)", () => {
  const originalFetch = globalThis.fetch;
  const prevHome = process.env.HOME;
  const prevDocsHost = process.env.CB_API_DOCS_HOST;
  const prevConfig = process.env.CHARGEBEE_CONFIG_DIR;
  let home: string;

  const SITEMAP_XML = `<urlset><url><loc>https://apidocs.chargebee.com/docs/api/customers/create-a-customer</loc></url></urlset>`;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cb-docs-hardening-"));
    process.env.HOME = home;
    __resetDocsMemoForTest();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetDocsMemoForTest();
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevDocsHost === undefined) delete process.env.CB_API_DOCS_HOST;
    else process.env.CB_API_DOCS_HOST = prevDocsHost;
    if (prevConfig === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prevConfig;
  });

  it("rejects a response whose declared Content-Length exceeds the cap", async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("sitemap.xml")) return new Response(SITEMAP_XML, { status: 200 });
      return new Response("small body", {
        status: 200,
        headers: { "content-length": String(6 * 1024 * 1024) },
      });
    }) as unknown as typeof fetch;

    const res = await fetchResource("customer");
    expect(res.ok).toBe(false);
  });

  it("rejects a streamed response whose actual body exceeds the cap", async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("sitemap.xml")) return new Response(SITEMAP_XML, { status: 200 });
      return new Response("x".repeat(6 * 1024 * 1024), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchResource("customer");
    expect(res.ok).toBe(false);
  });

  it("accepts a response under the cap", async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("sitemap.xml")) return new Response(SITEMAP_XML, { status: 200 });
      return new Response("# small doc\n", { status: 200 });
    }) as unknown as typeof fetch;

    const res = await fetchResource("customer");
    expect(res.ok).toBe(true);
  });

  it("rejects CB_API_DOCS_HOST with a plain http:// non-local host, without making a network call", async () => {
    process.env.CB_API_DOCS_HOST = "http://evil.example.com";
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(listResources()).rejects.toThrow(/https/i);
    expect(called).toBe(false);
  });

  it("allows CB_API_DOCS_HOST over plain http:// for localhost", async () => {
    process.env.CB_API_DOCS_HOST = "http://localhost:4000";
    globalThis.fetch = (async (url: string) => {
      expect(String(url)).toContain("http://localhost:4000");
      return new Response(
        `<urlset><url><loc>http://localhost:4000/docs/api/customers/create-a-customer</loc></url></urlset>`,
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const resources = await listResources();
    expect(resources).toContain("customers");
  });

  it("allows CB_API_DOCS_HOST over plain http:// for 127.0.0.1", async () => {
    process.env.CB_API_DOCS_HOST = "http://127.0.0.1:4000";
    globalThis.fetch = (async (url: string) => {
      expect(String(url)).toContain("http://127.0.0.1:4000");
      return new Response(
        `<urlset><url><loc>http://127.0.0.1:4000/docs/api/customers/create-a-customer</loc></url></urlset>`,
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const resources = await listResources();
    expect(resources).toContain("customers");
  });

  it("rejects a CB_API_DOCS_HOST that is not a URL", async () => {
    process.env.CB_API_DOCS_HOST = "not a url";
    await expect(listResources()).rejects.toThrow(/Invalid CB_API_DOCS_HOST/);
  });

  it("fetchOperation returns not_found for an unknown resource and lists ops for an unknown op", async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("sitemap.xml")) return new Response(SITEMAP_XML, { status: 200 });
      return new Response("# doc\n", { status: 200 });
    }) as unknown as typeof fetch;
    const missingRes = await fetchOperation("nope", "create");
    expect(missingRes).toEqual({ ok: false, reason: "not_found" });
    const missingOp = await fetchOperation("customer", "teleport");
    expect(missingOp.ok).toBe(false);
    if (!missingOp.ok) {
      expect(missingOp.reason).toBe("not_found");
      expect(missingOp.operations).toContain("create-a-customer");
    }
    expect(await listOperations("nope")).toEqual([]);
  });

  it("serves a fresh sitemap cache without fetching", async () => {
    const cfg = join(home, "cfg");
    process.env.CHARGEBEE_CONFIG_DIR = cfg;
    mkdirSync(join(cfg, "docs-cache"), { recursive: true });
    writeFileSync(
      join(cfg, "docs-cache", "sitemap.json"),
      JSON.stringify({ customers: { "create-a-customer": "/docs/api/customers/create-a-customer" } }),
    );
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;
    expect(await listResources()).toEqual(["customers"]);
    expect(fetched).toBe(false);
  });
});
