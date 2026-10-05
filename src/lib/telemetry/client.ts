import { HTTP_TIMEOUT_MS } from "./constants.js";
import type { CliAnalyticsCreateRequest } from "./types.js";

/**
 * POST one batch to the telemetry endpoint. Fully best-effort: returns true on a
 * 2xx response, false on any non-2xx / network error / timeout. Never throws.
 *
 * Deliberately sends no `Origin` header (a non-browser client), so the server's
 * CORS layer treats it as a plain request and lets it through.
 */
export async function postBatch(
  url: string,
  body: CliAnalyticsCreateRequest,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
