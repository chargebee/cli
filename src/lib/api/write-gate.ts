/**
 * Pure logic for the live-site write confirmation gate.
 *
 * Write operations on live (production) sites need explicit confirmation: an
 * interactive yes/no prompt, or `--allow-write`. Without a terminal and without
 * `--allow-write` the write is refused.
 *
 * Kept separate from `sdk.ts` (which imports the Chargebee SDK and is a common
 * mock target in tests) so this logic can be unit-tested in isolation.
 */
import { paint } from "../ui/color.js";

/**
 * Decide whether a site/key pair points at a LIVE (production) site.
 *
 * Primary signal: the site name. By Chargebee convention, test sites end in
 * "-test"; anything else is treated as live.
 * Secondary signal (only consulted when the site name is not a "-test" site):
 * an explicit API-key prefix — a `test_` key marks a test site, a `live_` key
 * confirms live.
 */
export function isLiveSite(site: string, apiKey?: string): boolean {
  // Primary: the site name takes precedence.
  if (/-test$/i.test(site.trim())) return false;
  // Secondary: fall back to an explicit API-key prefix.
  const key = (apiKey ?? "").trim();
  if (/^test_/i.test(key)) return false;
  if (/^live_/i.test(key)) return true;
  // Default to live — safer to over-protect than to allow accidental writes.
  return true;
}

/** Human/JSON label for the same classification as `isLiveSite`. */
export function siteMode(site: string, apiKey?: string): "test" | "live" {
  return isLiveSite(site, apiKey) ? "live" : "test";
}

/** HTTP methods that mutate data. Live sites need confirmation for these. */
export function isWriteMethod(method: string): boolean {
  return method.toUpperCase() !== "GET";
}

/**
 * Resources whose entire surface is read-only despite using non-GET methods:
 * estimate/export computations and hosted-page URL generation never mutate
 * billing data.
 */
const READ_ONLY_RESOURCES = new Set(["estimate", "export", "hostedPage"]);

/**
 * Operations on an otherwise read-only resource that do write state:
 * acknowledging a hosted page transitions it to `acknowledged`, and
 * `hostedPage.events` records an event in Chargebee.
 */
const MUTATING_OPERATIONS = new Set(["hostedPage.acknowledge", "hostedPage.events"]);

/** Individual `resource.action` operations that are read-only despite their method. */
const READ_ONLY_OPERATIONS = new Set([
  "portalSession.create",
  "invoice.pdf",
  "quote.pdf",
  "creditNote.pdf",
  "usage.pdf",
]);

/** Action-name verbs (camelCase word boundary) that are read-only regardless of resource. */
const READ_ONLY_ACTION_PREFIXES = ["retrieve", "list", "preview", "calculate", "check", "validate"];

function hasReadOnlyActionPrefix(action: string): boolean {
  return READ_ONLY_ACTION_PREFIXES.some((prefix) => {
    if (!action.toLowerCase().startsWith(prefix)) return false;
    const rest = action.slice(prefix.length);
    // Word boundary: reject e.g. "checkoutNew" matching the "check" prefix.
    return rest === "" || /^[A-Z0-9]/.test(rest);
  });
}

/**
 * Decide whether a generated `resource.action` operation (the same
 * `sdkName`/`sdkAction` pair used to call the SDK client) is read-only despite
 * using a non-GET HTTP method — e.g. `estimate.createSubscription`,
 * `portalSession.create`. Used by the generator to decide whether an
 * operation needs the live-site write confirmation at all.
 */
export function isReadOnlyOperation(operationKey?: string): boolean {
  if (!operationKey) return false;
  const dot = operationKey.indexOf(".");
  if (dot < 0) return false;
  const resource = operationKey.slice(0, dot);
  const action = operationKey.slice(dot + 1);
  if (!resource || !action) return false;
  if (MUTATING_OPERATIONS.has(operationKey)) return false;
  if (READ_ONLY_RESOURCES.has(resource)) return true;
  if (READ_ONLY_OPERATIONS.has(operationKey)) return true;
  return hasReadOnlyActionPrefix(action);
}

/**
 * How a write should proceed:
 * - `allow`: not a write, or not a live site — run without ceremony.
 * - `allow_live`: live-site write confirmed up front with `--allow-write`.
 * - `confirm`: live-site write that must be confirmed at an interactive prompt.
 * - `refuse`: live-site write with no `--allow-write` and no way to prompt.
 */
export type WriteDecision = "allow" | "allow_live" | "confirm" | "refuse";

export function liveWriteDecision(opts: {
  method: string;
  site: string;
  apiKey?: string;
  allowWrite: boolean;
  canPrompt: boolean;
}): WriteDecision {
  if (!isWriteMethod(opts.method) || !isLiveSite(opts.site, opts.apiKey)) return "allow";
  if (opts.allowWrite) return "allow_live";
  return opts.canPrompt ? "confirm" : "refuse";
}

/** The question asked before a write on a live site. */
export function liveWritePrompt(site: string, commandName: string): string {
  return `Run "${commandName}" on LIVE site "${site}"? This changes production data.`;
}

/** The stderr notice printed when a confirmed write runs on a live site. */
export function liveWriteNotice(site: string): string {
  return `${paint("33", "⚠")} Writing to live site "${site}".`;
}

/** The stderr notice printed when the deprecated `-y/--yes` confirms a write. */
export const DEPRECATED_YES_NOTICE =
  "warning: -y/--yes on API write commands is deprecated and will be removed in the next major version; use --allow-write.";

/** The message shown when a live-site write cannot be confirmed. */
export function unconfirmedWriteMessage(site: string, commandName: string): string {
  return (
    `${paint("31", "✗")} Refusing to run a write operation on live site "${site}" without confirmation.\n\n` +
    `  "${commandName}" changes data on a live (production) site.\n` +
    "  Re-run with --allow-write to confirm, or run it in a terminal to answer the prompt.\n" +
    '  To experiment safely, use a test site (name ending in "-test", or a test_ API key).\n'
  );
}
