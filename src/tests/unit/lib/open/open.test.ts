import { afterEach, describe, expect, it } from "bun:test";

import type { ChildProcess } from "node:child_process";

import {
  __setSpawnForTest,
  findByShortcut,
  listEntries,
  openBrowser,
  resolve,
  shouldOpenBrowser,
} from "../../../../lib/open/index.js";

/** Shell metacharacters that must never reach a child process unencoded. */
const HOSTILE_ID = 'x$(id)"; echo pwned; "';
const HOSTILE_ID_ENCODED = encodeURIComponent(HOSTILE_ID);

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  opts: Record<string, unknown>;
}

/** Record spawn calls without launching anything. */
function stubSpawn(): SpawnCall[] {
  const calls: SpawnCall[] = [];
  __setSpawnForTest(((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    const child = { unref() {}, on() { return child; } };
    return child as unknown as ChildProcess;
  }) as never);
  return calls;
}

describe("findByShortcut", () => {
  it("finds an entry by primary shortcut", () => {
    const entry = findByShortcut("customers");
    expect(entry.shortcut).toBe("customers");
    expect(entry.category).toBe("dashboard");
  });

  it("finds an entry by alias", () => {
    const entry = findByShortcut("customer");
    expect(entry.shortcut).toBe("customers");
  });

  it("is case-insensitive", () => {
    expect(findByShortcut("CUSTOMERS").shortcut).toBe("customers");
    expect(findByShortcut("Subscriptions").shortcut).toBe("subscriptions");
  });

  it("trims whitespace from shortcut", () => {
    expect(findByShortcut("  customers  ").shortcut).toBe("customers");
  });

  it("throws for unknown shortcut", () => {
    expect(() => findByShortcut("nonexistent")).toThrow("unknown shortcut");
  });

  it("finds multi-alias entries (sub, subs, subscription)", () => {
    expect(findByShortcut("sub").shortcut).toBe("subscriptions");
    expect(findByShortcut("subs").shortcut).toBe("subscriptions");
    expect(findByShortcut("subscription").shortcut).toBe("subscriptions");
  });

  it("does not open API docs", () => {
    expect(() => findByShortcut("docs")).toThrow(/unknown shortcut/);
    expect(() => findByShortcut("docs/customers")).toThrow(/unknown shortcut/);
  });
});

describe("resolve", () => {
  const base = "https://acme.chargebee.com";

  it("resolves list URL when no ID provided", () => {
    const url = resolve("customers", "", base);
    expect(url).toBe(`${base}/customers`);
  });

  it("resolves detail URL when ID is provided", () => {
    const url = resolve("customers", "cust_123", base);
    expect(url).toBe(`${base}/d/customers/cust_123`);
  });

  it("strips trailing slash from base URL", () => {
    const url = resolve("customers", "", `${base}/`);
    expect(url).toBe(`${base}/customers`);
  });

  it("throws when trying to open list-only entry by ID", () => {
    // settings has no detailPath
    expect(() => resolve("settings", "some_id", base)).toThrow("does not support opening by ID");
  });

  it("resolves subscription list URL via alias", () => {
    const url = resolve("sub", "", base);
    expect(url).toBe(`${base}/subscriptions`);
  });

  it("percent-encodes shell metacharacters in the resource id", () => {
    const url = resolve("customers", HOSTILE_ID, base);
    expect(url).toBe(`${base}/d/customers/${HOSTILE_ID_ENCODED}`);
    expect(url).not.toContain("$(");
    expect(url).not.toContain('"');
    expect(url).not.toContain(";");
    expect(url).not.toContain(" ");
  });

  it("percent-encodes path and query separators in the resource id", () => {
    const url = resolve("customers", "../../settings?x=1#f", base);
    expect(url).toBe(`${base}/d/customers/..%2F..%2Fsettings%3Fx%3D1%23f`);
  });

  it("rejects HTTP browser URLs", () => {
    expect(() => resolve("customers", "", "http://acme.chargebee.com")).toThrow(/refusing/i);
  });

  it("refuses base URLs whose host is not a Chargebee host", () => {
    expect(() => resolve("customers", "", "https://acme.evil.com")).toThrow(/refusing/i);
    expect(() => resolve("customers", "", "https://chargebee.com.evil.com")).toThrow(/refusing/i);
    expect(() => resolve("customers", "", "not a url")).toThrow(/refusing/i);
  });

  it("refuses a site that smuggles a different host into the URL", () => {
    // `apiBaseURL("acme/../evil.com/", host)` style input: hostname is not allowlisted
    expect(() => resolve("customers", "", "https://acme/..@evil.com.chargebee.com")).toThrow(
      /refusing/i,
    );
  });
});

describe("listEntries", () => {
  it("returns all entries when no category filter", () => {
    const entries = listEntries();
    expect(entries.length).toBeGreaterThan(20);
  });

  it("filters by dashboard category", () => {
    const entries = listEntries("dashboard");
    expect(entries.every((e) => e.category === "dashboard")).toBe(true);
    expect(entries.length).toBeGreaterThan(5);
  });

  it("filters by admin category", () => {
    const entries = listEntries("admin");
    expect(entries.every((e) => e.category === "admin")).toBe(true);
    expect(entries.length).toBeGreaterThan(3);
  });

  it("sorts dashboard entries before admin", () => {
    const entries = listEntries();
    const categories = entries.map((e) => e.category);
    const dashEnd = categories.lastIndexOf("dashboard");
    const adminStart = categories.indexOf("admin");
    expect(dashEnd).toBeLessThan(adminStart);
    expect(categories).not.toContain("docs");
  });

  it("returns empty array for unknown category", () => {
    expect(listEntries("unknown_category")).toHaveLength(0);
  });
});

describe("shouldOpenBrowser", () => {
  const prevCi = process.env.CI;
  const prevDisplay = process.env.DISPLAY;
  const prevWayland = process.env.WAYLAND_DISPLAY;
  const origTty = process.stdout.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: origTty, configurable: true });
    if (prevCi === undefined) delete process.env.CI;
    else process.env.CI = prevCi;
    if (prevDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = prevDisplay;
    if (prevWayland === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = prevWayland;
  });

  it("is false when stdout is not a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    expect(shouldOpenBrowser()).toBe(false);
  });

  it("is false in CI even when stdout is a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    process.env.CI = "1";
    expect(shouldOpenBrowser()).toBe(false);
  });

  it("is true for an interactive non-CI terminal", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    delete process.env.CI;
    if (process.platform === "linux") process.env.DISPLAY = ":0";
    expect(shouldOpenBrowser()).toBe(true);
  });

  it("is false on linux without DISPLAY or WAYLAND_DISPLAY", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    delete process.env.CI;
    const origPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    try {
      expect(shouldOpenBrowser()).toBe(false);
    } finally {
      if (origPlatform) Object.defineProperty(process, "platform", origPlatform);
    }
  });
});

describe("openBrowser", () => {
  afterEach(() => {
    __setSpawnForTest(null);
  });

  it("passes the URL as a single argv element with no shell (darwin)", () => {
    const calls = stubSpawn();
    const url = `https://acme.chargebee.com/d/customers/${HOSTILE_ID_ENCODED}`;
    openBrowser(url, "darwin");
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("open");
    expect(calls[0].args).toEqual([url]);
    expect(calls[0].opts.shell).toBeFalsy();
    expect(calls[0].opts.stdio).toBe("ignore");
  });

  it("uses xdg-open on linux", () => {
    const calls = stubSpawn();
    openBrowser("https://acme.chargebee.com/customers", "linux");
    expect(calls[0].cmd).toBe("xdg-open");
    expect(calls[0].args).toEqual(["https://acme.chargebee.com/customers"]);
  });

  it("uses rundll32 (not cmd /c start) on win32", () => {
    const calls = stubSpawn();
    openBrowser("https://acme.chargebee.com/customers", "win32");
    expect(calls[0].cmd).toBe("rundll32");
    expect(calls[0].args).toEqual([
      "url.dll,FileProtocolHandler",
      "https://acme.chargebee.com/customers",
    ]);
    expect(calls[0].opts.shell).toBeFalsy();
  });

  it("never hands raw shell metacharacters to the opener", () => {
    const calls = stubSpawn();
    const url = resolve("customers", HOSTILE_ID, "https://acme.chargebee.com");
    openBrowser(url, "darwin");
    const joined = [calls[0].cmd, ...calls[0].args].join(" ");
    expect(joined).toContain(HOSTILE_ID_ENCODED);
    expect(joined).not.toContain(HOSTILE_ID);
    expect(joined).not.toContain("$(");
  });

  it("refuses javascript:, file:, and non-http(s) URLs", () => {
    const calls = stubSpawn();
    expect(() => openBrowser("javascript:alert(1)", "darwin")).toThrow(/refusing/i);
    expect(() => openBrowser("file:///etc/passwd", "darwin")).toThrow(/refusing/i);
    expect(() => openBrowser("ftp://acme.chargebee.com/x", "darwin")).toThrow(/refusing/i);
    expect(calls).toHaveLength(0);
  });

  it("refuses hosts outside the Chargebee allowlist", () => {
    const calls = stubSpawn();
    expect(() => openBrowser("https://evil.com/", "darwin")).toThrow(/refusing/i);
    expect(() => openBrowser("https://acme.chargebee.com.evil.com/", "darwin")).toThrow(/refusing/i);
    expect(() => openBrowser("http://acme.chargebee.com/", "darwin")).toThrow(/refusing/i);
    expect(calls).toHaveLength(0);
  });

  it("allows github.com on the whole hostname only, over https", () => {
    const calls = stubSpawn();
    openBrowser("https://github.com/chargebee/cli/issues/new/choose", "darwin");
    expect(calls).toHaveLength(1);
    expect(() => openBrowser("https://github.com.evil.tld/", "darwin")).toThrow(/refusing/i);
    expect(() => openBrowser("https://evil.github.com.co/", "darwin")).toThrow(/refusing/i);
    expect(() => openBrowser("http://github.com/", "darwin")).toThrow(/refusing/i);
    expect(calls).toHaveLength(1);
  });

  it("refuses the feedback form host and mailto links", () => {
    const calls = stubSpawn();
    expect(() => openBrowser("https://forms.gle/n1CGr8HaHM6B669h8", "darwin")).toThrow(/refusing/i);
    expect(() => openBrowser("https://forms.gle/other", "darwin")).toThrow(/refusing/i);
    expect(() => openBrowser("mailto:dx@chargebee.com?subject=Hi", "darwin")).toThrow(/refusing/i);
    expect(calls).toHaveLength(0);
  });

  it("allows production support, API docs, and site URLs", () => {
    const calls = stubSpawn();
    openBrowser("https://support.chargebee.com", "darwin");
    openBrowser("https://apidocs.chargebee.com/docs/api", "linux");
    openBrowser("https://acme.chargebee.com/customers", "linux");
    expect(calls).toHaveLength(3);
  });

  it("ignores a missing opener so a spawn error cannot crash the CLI", () => {
    let onError: (() => void) | undefined;
    __setSpawnForTest((() => {
      const child = {
        unref() {},
        on(event: string, fn: () => void) {
          if (event === "error") onError = fn;
          return child;
        },
      };
      return child as unknown as ChildProcess;
    }) as never);
    openBrowser("https://acme.chargebee.com/customers", "linux");
    expect(onError).toBeDefined();
    expect(() => onError!()).not.toThrow();
  });
});
