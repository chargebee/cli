import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetDocsMemoForTest } from "../../lib/docs/index.js";
import { runCli } from "../../lib/test-support/_helpers.js";

const SITEMAP = `<?xml version="1.0"?>
<urlset>
  <loc>https://apidocs.chargebee.com/docs/api/customers/create-a-customer</loc>
  <loc>https://apidocs.chargebee.com/docs/api/customers/list-customers</loc>
</urlset>
`;

describe("docs command (mocked fetch)", () => {
  const prevHome = process.env.HOME;
  const prevConfig = process.env.CHARGEBEE_CONFIG_DIR;
  const originalFetch = globalThis.fetch;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cb-docs-home-"));
    process.env.HOME = home;
    process.env.CHARGEBEE_CONFIG_DIR = join(home, "cfg");
    __resetDocsMemoForTest();
    globalThis.fetch = (async (url: string) => {
      const href = String(url);
      if (href.includes("sitemap.xml"))
        return new Response(SITEMAP, { status: 200 });
      if (href.endsWith(".md")) {
        return new Response(`# Doc for ${href}\n`, { status: 200 });
      }
      return new Response("missing", { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __resetDocsMemoForTest();
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevConfig === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prevConfig;
  });

  it("lists resources when called with no args", async () => {
    const { stdout, exitCode } = await runCli(["docs"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("customers");
    expect(stdout).toContain("Usage: chargebee docs");
  });

  it("prints a resource overview and operations", async () => {
    const { stdout, exitCode } = await runCli(["docs", "customer"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Doc for");
    expect(stdout).toContain("create-a-customer");
    expect(stdout).toContain("Source:");
  });

  it("prints an operation page", async () => {
    const { stdout, exitCode } = await runCli(["docs", "customer", "create"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Doc for");
    expect(stdout).toContain("Source:");
  });

  it("strips control characters from printed pages but caches the raw body", async () => {
    globalThis.fetch = (async (url: string) => {
      const href = String(url);
      if (href.includes("sitemap.xml")) return new Response(SITEMAP, { status: 200 });
      return new Response("# Doc\x1b[31m red\x1b[0m\x07\n", { status: 200 });
    }) as unknown as typeof fetch;
    const { stdout, exitCode } = await runCli(["docs", "customer"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("# Doc[31m red[0m");
    expect(stdout).not.toContain("\x1b");
    const cached = readFileSync(
      join(home, "cfg", "docs-cache", "_docs_api_customers.md"),
      "utf-8",
    );
    expect(cached).toContain("\x1b[31m");
  });

  it("caches under CHARGEBEE_CONFIG_DIR, not a hardcoded ~/.chargebee/cli, and creates it 0700", async () => {
    const { exitCode } = await runCli(["docs", "customer"]);
    expect(exitCode).toBe(0);
    const cacheDir = join(home, "cfg", "docs-cache");
    expect(existsSync(join(cacheDir, "sitemap.json"))).toBe(true);
    expect(existsSync(join(home, ".chargebee"))).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
    }
  });

  it("errors on an unknown resource and unknown operation", async () => {
    const unknownRes = await runCli(["docs", "no-such-resource"]);
    expect(unknownRes.exitCode).toBe(1);
    expect(unknownRes.stderr).toContain("Unknown resource");
    const unknownOp = await runCli(["docs", "customer", "no-such-op"]);
    expect(unknownOp.exitCode).toBe(1);
    expect(unknownOp.stderr).toContain("Unknown operation");
  });

  it("errors on an unknown resource even when an operation is given", async () => {
    const { exitCode, stderr } = await runCli(["docs", "no-such-resource", "create"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown resource");
  });

  it("errors when an operation page is unreachable with a warm sitemap", async () => {
    globalThis.fetch = (async (url: string) => {
      const href = String(url);
      if (href.includes("sitemap.xml")) return new Response(SITEMAP, { status: 200 });
      if (href.includes("create-a-customer")) throw new Error("offline");
      if (href.endsWith(".md")) return new Response("# Doc\n", { status: 200 });
      return new Response("missing", { status: 404 });
    }) as unknown as typeof fetch;
    const { exitCode, stderr } = await runCli(["docs", "customer", "create"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Could not reach apidocs.chargebee.com");
  });

  it("errors when offline with a cold cache", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    __resetDocsMemoForTest();
    const { exitCode, stderr } = await runCli(["docs"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Could not reach apidocs.chargebee.com");
  });
});
