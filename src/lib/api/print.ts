import { diagnostic, exitCommand, finishOutput, isJsonMode, OutputError, OutputExit, printJson } from "../output.js";
import { classifyNonSdkError, recordTelemetryError } from "../telemetry/error.js";
import { EXIT_CODES } from "../exit-codes.js";
import { NetworkError, resolveTimeoutMs, transportErrorCode } from "./sdk.js";

/** Chargebee Node SDK attaches these to every success response. */
const SDK_SUCCESS_TRANSPORT_KEYS = ["headers", "httpStatusCode", "isIdempotencyReplayed"] as const;

/** SDK error objects also carry a raw header map; keep http_status_code / error_code / message. */
const SDK_ERROR_TRANSPORT_KEYS = ["headers"] as const;

/**
 * Print an SDK response as formatted JSON.
 * Strips SDK HTTP transport fields.
 */
export function printResult(result: unknown): void {
  const data = expandListCursor(stripTransport(result, SDK_SUCCESS_TRANSPORT_KEYS));
  printJson(data);
}

/**
 * A list cursor is a string whose text is a JSON array.
 * Print that array so it can be passed back as `-d offset=`.
 * Operates on the stripped copy from `stripTransport`.
 */
function expandListCursor(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;

  const body = data as Record<string, unknown>;
  const offset = body.next_offset;
  if (typeof offset !== "string") return data;

  const trimmed = offset.trim();
  if (!trimmed.startsWith("[")) return data;

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) body.next_offset = parsed;
  } catch {
    // Cursor text is not a JSON array; print the string as returned.
  }
  return data;
}

/**
 * Handle a Chargebee SDK error — print structured JSON and detect PC version hints.
 *
 * `unexpected` marks a crash that escaped every command's own handling, which
 * is the only failure worth inviting a bug report for.
 */
export function handleSdkError(err: unknown, opts: { unexpected?: boolean } = {}): never {
  if (err instanceof OutputExit) throw err;
  if (isJsonMode()) {
    let code = err instanceof OutputError ? err.code : "command_failed";
    let message = formatNonSdkError(err);
    let exitCode = exitCodeForNonSdkError(err);
    let details = err instanceof OutputError ? err.details : undefined;
    let telemetryCode = classifyNonSdkError(err);
    if (exitCode === EXIT_CODES.NETWORK) code = "network_error";
    if (exitCode === EXIT_CODES.UNCONFIGURED) code = "unconfigured";

    if (err && typeof err === "object" && "http_status_code" in err) {
      const sdk = err as Record<string, unknown>;
      const status = sdk.http_status_code as number | undefined;
      exitCode = exitCodeForStatus(status);
      code = "api_error";
      message = String(sdk.message ?? "API request failed.");
      telemetryCode = status ? `api_${status}` : "api_error";
      if (sdk.type === "timeout") {
        code = "timeout";
        exitCode = EXIT_CODES.NETWORK;
        telemetryCode = "api_timeout";
        message = `Request timed out after ${resolveTimeoutMs() / 1000}s; set CHARGEBEE_CLI_TIMEOUT_MS to raise it.`;
      } else if (status === 429) {
        code = "rate_limited";
        message = formatRateLimitMessage(sdk);
      }
      // Select documented error fields; transport headers never enter machine output.
      details = {
        http_status_code: status,
        type: sdk.type,
        api_error_code: sdk.api_error_code,
        error_code: sdk.error_code,
        param: sdk.param,
      };
    }
    recordTelemetryError(telemetryCode);
    diagnostic(message);
    finishOutput(exitCode, code, details);
    exitCommand(exitCode);
  }
  if (err && typeof err === "object" && "http_status_code" in err) {
    const status = (err as { http_status_code?: number }).http_status_code;
    const type = (err as { type?: string }).type;

    if (type === "timeout") {
      recordTelemetryError("api_timeout");
      console.error(
        `Request timed out after ${resolveTimeoutMs() / 1000}s; set CHARGEBEE_CLI_TIMEOUT_MS to raise it.`,
      );
      process.exit(EXIT_CODES.NETWORK);
    } else if (status === 429) {
      recordTelemetryError("api_429");
      console.error(formatRateLimitMessage(err as Record<string, unknown>));
      process.exit(EXIT_CODES.ERROR);
    } else {
      recordTelemetryError(status ? `api_${status}` : "api_error");
      const body = stripTransport(err, SDK_ERROR_TRANSPORT_KEYS);
      console.error(JSON.stringify(body, null, 2));
      detectPCHint(body as Record<string, unknown>);
      process.exit(exitCodeForStatus(status));
    }
  }

  // Non-SDK error (e.g. unconfigured site, auth/config failure, network issue).
  // Print a clean message and exit instead of rethrowing, which would surface a
  // raw runtime unhandled-rejection banner from inside the async command action.
  recordTelemetryError(classifyNonSdkError(err));
  console.error(formatNonSdkError(err));
  const code = exitCodeForNonSdkError(err);
  // An unconfigured site or a dropped connection is not a defect, so those
  // keep their own guidance and exit codes.
  if (opts.unexpected && code === EXIT_CODES.ERROR) {
    console.error(
      "\nThis looks like a bug in the CLI. Report it with 'chargebee feedback \"what happened\"'.",
    );
  }
  process.exit(code);
}

/** Exit code for an SDK error response, by HTTP status. */
function exitCodeForStatus(status: number | undefined): number {
  if (status === 401) return EXIT_CODES.INVALID_CREDENTIALS;
  if (status === 404) return EXIT_CODES.NOT_FOUND;
  return EXIT_CODES.ERROR;
}

/**
 * Exit code for a non-SDK error (unconfigured, network, or anything else).
 * `transportErrorCode` catches a network failure whether or not it was
 * already wrapped as a {@link NetworkError} — most command actions let a raw
 * `fetch` failure reach here unwrapped.
 */
function exitCodeForNonSdkError(err: unknown): number {
  if (err instanceof NetworkError || transportErrorCode(err)) return EXIT_CODES.NETWORK;
  if (classifyNonSdkError(err) === "unconfigured") return EXIT_CODES.UNCONFIGURED;
  return EXIT_CODES.ERROR;
}

/**
 * Format a non-SDK error for stderr. Node's global `fetch` throws a generic
 * `TypeError: fetch failed` and puts the actionable reason (`ENOTFOUND`,
 * `ECONNREFUSED`, `SELF_SIGNED_CERT_IN_CHAIN`, a proxy refusal, …) on
 * `err.cause`; Bun's `fetch` throws a generic "Unable to connect…" with the
 * reason on `err.code`. Append whichever is present.
 */
function formatNonSdkError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (cause === undefined) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${err.message} (${code})` : err.message;
  }
  const causeDetail =
    cause instanceof Error
      ? String((cause as NodeJS.ErrnoException).code ?? cause.message)
      : cause && typeof cause === "object" && "code" in cause
        ? String((cause as { code?: unknown }).code)
        : String(cause);
  return `${err.message} (${causeDetail})`;
}

/**
 * Format a rate-limit (429) message. The SDK attaches the response's raw,
 * lowercased header map to the error as `headers`; when it carries a
 * `retry-after` value that is surfaced directly, otherwise the API's own
 * `message` field is used.
 */
function formatRateLimitMessage(err: Record<string, unknown>): string {
  const headers = err.headers as Record<string, string> | undefined;
  const retryAfter = headers?.["retry-after"];
  if (retryAfter) {
    return `Rate limited by Chargebee; retry after ${retryAfter} seconds.`;
  }
  const message = typeof err.message === "string" ? err.message : "Too many requests.";
  return `Rate limited by Chargebee: ${message}`;
}

/**
 * Clone `data` and lift known SDK transport keys off it. Shallow copy so the
 * original SDK object is not mutated.
 */
function stripTransport(
  data: unknown,
  keys: readonly string[],
): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return data;
  }

  const body: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const key of keys) {
    delete body[key];
  }
  return body;
}

/**
 * Print a precise, catalog-aware hint when an operation is incompatible with
 * the site's product catalog. The error code tells us the site's catalog
 * version directly, so we can name the right resources to use instead.
 */
function detectPCHint(err: Record<string, unknown>): void {
  const code = err.error_code as string | undefined;
  switch (code) {
    case "configuration_incompatible":
    case "pc1_to_pc2_error":
      process.stderr.write(
        "\n\u26A0  This operation isn't available on your site's product catalog.\n" +
          "   Your site uses Product Catalog 1.0 (PC1) \u2014 plans & addons.\n" +
          "   \u2022 Use PC1 resources: 'plan', 'addon', 'subscription create' (with plan_id).\n" +
          "   \u2022 'item', 'item-price', and 'item-family' are Product Catalog 2.0 (PC2) only.\n" +
          "   Tip: run 'chargebee auth status' to confirm your catalog version.\n\n"
      );
      break;
    case "pc2_to_pc1_error":
      process.stderr.write(
        "\n\u26A0  This operation isn't available on your site's product catalog.\n" +
          "   Your site uses Product Catalog 2.0 (PC2) \u2014 items & item prices.\n" +
          "   \u2022 Use PC2 resources: 'item', 'item-price', 'subscription create-with-items'.\n" +
          "   \u2022 'plan' and 'addon' are Product Catalog 1.0 (PC1) only.\n" +
          "   Tip: run 'chargebee auth status' to confirm your catalog version.\n\n"
      );
      break;
  }
}
