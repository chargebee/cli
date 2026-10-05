import { spawn } from "node:child_process";

import { isAllowedHostname } from "../config/host.js";

type SpawnFn = typeof spawn;
let spawnImpl: SpawnFn = spawn;

/** TEST-ONLY: replace `spawn` so browser-open tests never launch a browser. */
export function __setSpawnForTest(fn: SpawnFn | null): void {
  spawnImpl = fn ?? spawn;
}

export interface URLEntry {
  shortcut: string;
  aliases: string[];
  description: string;
  listPath: string;
  detailPath: string;
  category: string;
}

const registry: URLEntry[] = [
  // Dashboard — resources with list + detail views
  { shortcut: "customers", aliases: ["customer"], description: "Customer list / detail", listPath: "/customers", detailPath: "/d/customers/{id}", category: "dashboard" },
  { shortcut: "subscriptions", aliases: ["subscription", "subs", "sub"], description: "Subscription list / detail", listPath: "/subscriptions", detailPath: "/d/subscriptions/{id}", category: "dashboard" },
  { shortcut: "invoices", aliases: ["invoice", "inv"], description: "Invoice list / detail", listPath: "/invoices", detailPath: "/d/invoices/{id}", category: "dashboard" },
  { shortcut: "credit-notes", aliases: ["credit-note", "credit_notes", "cn"], description: "Credit note list / detail", listPath: "/credit_notes", detailPath: "/d/credit_notes/{id}", category: "dashboard" },
  { shortcut: "plans", aliases: ["plan"], description: "Plan list / detail", listPath: "/plans", detailPath: "/d/plans/{id}", category: "dashboard" },
  { shortcut: "addons", aliases: ["addon", "add-ons", "add-on"], description: "Addon list / detail", listPath: "/addons", detailPath: "/d/addons/{id}", category: "dashboard" },
  { shortcut: "charges", aliases: ["charge"], description: "Charge list / detail", listPath: "/charges", detailPath: "/d/charges/{id}", category: "dashboard" },
  { shortcut: "coupons", aliases: ["coupon"], description: "Coupon list / detail", listPath: "/coupons", detailPath: "/d/coupons/{id}", category: "dashboard" },
  { shortcut: "features", aliases: ["feature"], description: "Feature list / detail", listPath: "/features", detailPath: "/d/features/{id}", category: "dashboard" },
  { shortcut: "transactions", aliases: ["transaction", "txn"], description: "Transaction list / detail", listPath: "/transactions", detailPath: "/d/transactions/{id}", category: "dashboard" },
  { shortcut: "events", aliases: ["event", "ev"], description: "Event list / detail", listPath: "/events", detailPath: "/d/events/{id}", category: "dashboard" },

  // Dashboard — list only
  { shortcut: "coupon-sets", aliases: ["coupon-set", "coupon_sets"], description: "Coupon set list", listPath: "/coupon_sets", detailPath: "", category: "dashboard" },
  { shortcut: "product-families", aliases: ["product-family", "product_families"], description: "Product family list", listPath: "/product_families", detailPath: "", category: "dashboard" },
  { shortcut: "payment-intents", aliases: ["payment-intent", "payment_intents"], description: "Payment intent list", listPath: "/payment_intents", detailPath: "", category: "dashboard" },
  { shortcut: "gateway-logs", aliases: ["gateway-request-logs", "gateway_request_logs"], description: "Gateway request logs", listPath: "/gateway_request_logs", detailPath: "", category: "dashboard" },
  { shortcut: "emails", aliases: ["email-notifications", "email_notifications", "sent-mail"], description: "Email notifications", listPath: "/email_notifications/sent_mail", detailPath: "", category: "dashboard" },

  // Admin pages
  { shortcut: "dashboard", aliases: ["home"], description: "Dashboard home", listPath: "/", detailPath: "", category: "admin" },
  { shortcut: "settings", aliases: ["config"], description: "Site settings", listPath: "/settings", detailPath: "", category: "admin" },
  { shortcut: "reports", aliases: ["report"], description: "Reports", listPath: "/reports", detailPath: "", category: "admin" },
  { shortcut: "users", aliases: ["user", "team"], description: "User management", listPath: "/users", detailPath: "", category: "admin" },
  { shortcut: "security", aliases: [], description: "Security settings", listPath: "/security", detailPath: "", category: "admin" },
  { shortcut: "integrations", aliases: ["integration"], description: "Integrations", listPath: "/integrations", detailPath: "", category: "admin" },
  { shortcut: "import-export", aliases: ["import_and_export", "import", "export"], description: "Import & export", listPath: "/import_and_export", detailPath: "", category: "admin" },
  { shortcut: "notifications", aliases: ["chargebee-notifications", "chargebee_notifications"], description: "Chargebee notifications", listPath: "/chargebee_notifications", detailPath: "", category: "admin" },
];

// Build index: shortcut/alias → registry index
const shortcutIndex = new Map<string, number>();
registry.forEach((entry, i) => {
  shortcutIndex.set(entry.shortcut, i);
  for (const alias of entry.aliases) {
    shortcutIndex.set(alias, i);
  }
});

/** Find an entry by shortcut or alias. */
export function findByShortcut(shortcut: string): URLEntry {
  const idx = shortcutIndex.get(shortcut.toLowerCase().trim());
  if (idx === undefined) {
    throw new Error(
      `unknown shortcut "${shortcut}" — run 'chargebee open --list' to see available shortcuts`
    );
  }
  return registry[idx];
}

/** Resolve a full URL for a shortcut with optional resource ID. */
export function resolve(
  shortcut: string,
  resourceId: string,
  baseURL: string
): string {
  const entry = findByShortcut(shortcut);
  if (resourceId) {
    if (!entry.detailPath) {
      throw new Error(`"${entry.shortcut}" does not support opening by ID`);
    }
    // Ids are merchant-supplied strings: encode so they can never break out of
    // the path segment (or, downstream, out of an argv element).
    return assertOpenableURL(
      baseURL.replace(/\/+$/, "") + entry.detailPath.replace("{id}", encodeURIComponent(resourceId)),
    );
  }

  return assertOpenableURL(baseURL.replace(/\/+$/, "") + entry.listPath);
}

/**
 * Non-Chargebee hosts the CLI may open, matched on the whole hostname over
 * https only. A suffix match would also admit `github.com.evil.tld`.
 */
const EXTRA_OPENABLE_HOSTS = new Set(["github.com"]);

/**
 * Only hand well-formed Chargebee URLs to a browser: `https://` on an
 * allowlisted production host.
 * Returns the input unchanged so it can wrap an expression.
 */
export function assertOpenableURL(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`refusing to open ${JSON.stringify(url)}: not a valid URL`);
  }
  const httpsOk = parsed.protocol === "https:";
  const hostOk =
    isAllowedHostname(parsed.hostname) ||
    (httpsOk && EXTRA_OPENABLE_HOSTS.has(parsed.hostname.toLowerCase()));
  if (!httpsOk || !hostOk) {
    throw new Error(
      `refusing to open ${JSON.stringify(url)}: only https:// Chargebee URLs can be opened`,
    );
  }
  return url;
}

/** List all entries, optionally filtered by category. Sorted by category then shortcut. */
export function listEntries(category?: string): URLEntry[] {
  const CATEGORY_ORDER: Record<string, number> = { dashboard: 0, admin: 1 };
  let entries = category
    ? registry.filter((e) => e.category === category)
    : [...registry];
  return entries.sort((a, b) => {
    const catDiff = (CATEGORY_ORDER[a.category] ?? 3) - (CATEGORY_ORDER[b.category] ?? 3);
    return catDiff !== 0 ? catDiff : a.shortcut.localeCompare(b.shortcut);
  });
}

/**
 * Open a URL in the default browser.
 *
 * The URL is passed as a single argv element to the platform opener — never
 * through a shell — so ids, site names and hosts cannot inject commands.
 * `cmd /c start` is deliberately avoided on Windows: cmd.exe still interprets
 * `&`, `^` and `%` inside an argv element.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  assertOpenableURL(url);
  let cmd: string;
  let args: string[];
  switch (platform) {
    case "darwin":
      cmd = "open";
      args = [url];
      break;
    case "win32":
      cmd = "rundll32";
      args = ["url.dll,FileProtocolHandler", url];
      break;
    default:
      cmd = "xdg-open";
      args = [url];
  }
  const child = spawnImpl(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
  // A missing opener (e.g. no xdg-open) must not crash the CLI: callers have
  // already printed the URL, so the user can open it by hand.
  child.on("error", () => {});
  child.unref();
}

/** Returns true if we should auto-open browser (interactive terminal, not CI). */
export function shouldOpenBrowser(): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.env.CI) return false;
  if (
    process.platform === "linux" &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  )
    return false;
  return true;
}
