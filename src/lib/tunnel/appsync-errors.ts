/**
 * Error contract between AppSync handlers and `chargebee listen`.
 *
 * Connect 401s are AppSync's envelope (`UnauthorizedException` / `errorCode`).
 * That surface cannot carry our codes — treat it as opaque.
 *
 * `onSubscribe` / `onPublish` return `{ error: CODE }` or `{ error: CODE:detail }`.
 * Those strings are ours; the CLI switches on `CODE`.
 */

export const AppSyncErrorCode = {
  APPSYNC_UNAUTHORIZED: "APPSYNC_UNAUTHORIZED",
  APPSYNC_ERROR: "APPSYNC_ERROR",
  INVALID_CHANNEL: "INVALID_CHANNEL",
  MISSING_DOMAIN: "MISSING_DOMAIN",
  ENABLE_FAILED: "ENABLE_FAILED",
  CONTROL_FAILED: "CONTROL_FAILED",
  WEBSOCKET_UNAVAILABLE: "WEBSOCKET_UNAVAILABLE",
} as const;

export type AppSyncErrorCode = (typeof AppSyncErrorCode)[keyof typeof AppSyncErrorCode];

/** Handler `{ error }` payload: `CODE` or `CODE:detail`. */
const HANDLER_ERROR_RE = /^([A-Z][A-Z0-9_]*)(?::(.*))?$/;

export type AppSyncFailure = {
  code: string;
  detail?: string;
  permanent: boolean;
  reason: string;
};

type AppSyncErrorItem = {
  errorType?: string;
  message?: string;
  error?: string;
  errorCode?: number;
};

type AppSyncErrorMessage = {
  type?: string;
  errors?: unknown;
  error?: unknown;
};

/** Format a handler error string. Keep in sync with the authorizer Lambdas. */
export function handlerError(code: string, detail?: string | number): string {
  if (detail === undefined || detail === "") return code;
  return `${code}:${detail}`;
}

export function parseHandlerError(raw: string): { code: string; detail?: string } | null {
  const m = HANDLER_ERROR_RE.exec(raw.trim());
  if (!m) return null;
  return m[2] === undefined || m[2] === "" ? { code: m[1]! } : { code: m[1]!, detail: m[2] };
}

function httpStatus(detail: string | undefined): number | undefined {
  if (!detail) return undefined;
  const last = detail.split(":").pop();
  if (!last || !/^\d{3}$/.test(last)) return undefined;
  return Number(last);
}

function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  return status === 408 || status === 429 || status >= 500;
}

function isPermanentHandlerCode(code: string, detail?: string): boolean {
  if (code === AppSyncErrorCode.ENABLE_FAILED || code === AppSyncErrorCode.CONTROL_FAILED) {
    return !isRetryableStatus(httpStatus(detail));
  }
  return true;
}

function asErrorItem(value: unknown): AppSyncErrorItem | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const item: AppSyncErrorItem = {};
  if (typeof o.errorType === "string") item.errorType = o.errorType;
  if (typeof o.message === "string") item.message = o.message;
  if (typeof o.error === "string") item.error = o.error;
  if (typeof o.errorCode === "number") item.errorCode = o.errorCode;
  return item;
}

function errorItems(msg: AppSyncErrorMessage): AppSyncErrorItem[] {
  const items: AppSyncErrorItem[] = [];
  if (typeof msg.error === "string") items.push({ message: msg.error });
  if (typeof msg.errors === "string") items.push({ message: msg.errors });
  if (Array.isArray(msg.errors)) {
    for (const raw of msg.errors) {
      if (typeof raw === "string") {
        items.push({ message: raw });
        continue;
      }
      const item = asErrorItem(raw);
      if (item) items.push(item);
    }
  }
  return items;
}

function isUnauthorizedItem(item: AppSyncErrorItem): boolean {
  if (item.errorCode === 401 || item.errorCode === 403) return true;
  return /unauthorizedexception/i.test(item.errorType ?? "");
}

/** Classify a connect / subscribe / error frame. Handler `CODE`s win over 401s. */
export function classifyAppSyncFailure(msg: AppSyncErrorMessage): AppSyncFailure {
  const items = errorItems(msg);

  for (const item of items) {
    const parsed = parseHandlerError(item.message ?? item.error ?? "");
    if (!parsed) continue;
    return {
      code: parsed.code,
      detail: parsed.detail,
      permanent: isPermanentHandlerCode(parsed.code, parsed.detail),
      reason: listenUserMessage(parsed.code, parsed.detail),
    };
  }

  if (items.some(isUnauthorizedItem)) {
    return {
      code: AppSyncErrorCode.APPSYNC_UNAUTHORIZED,
      permanent: true,
      reason: listenUserMessage(AppSyncErrorCode.APPSYNC_UNAUTHORIZED),
    };
  }

  return {
    code: AppSyncErrorCode.APPSYNC_ERROR,
    permanent: false,
    reason: listenUserMessage(AppSyncErrorCode.APPSYNC_ERROR),
  };
}

/**
 * User-facing copy. No vendor or pipeline names (AppSync, Lambda, authorizer).
 */
export function listenUserMessage(code: string, detail?: string): string {
  switch (code) {
    case AppSyncErrorCode.APPSYNC_UNAUTHORIZED:
      return "Could not authorize the listen session.";
    case AppSyncErrorCode.INVALID_CHANNEL:
      return "This listen session was rejected.";
    case AppSyncErrorCode.MISSING_DOMAIN:
      return "The listen session is missing a site.";
    case AppSyncErrorCode.ENABLE_FAILED: {
      const status = httpStatus(detail);
      return status
        ? `Could not register the listen session with Chargebee (HTTP ${status}).`
        : "Could not register the listen session with Chargebee.";
    }
    case AppSyncErrorCode.CONTROL_FAILED:
      return "Session keepalive against Chargebee failed.";
    case AppSyncErrorCode.APPSYNC_ERROR:
      return "The webhook tunnel returned an error.";
    case AppSyncErrorCode.WEBSOCKET_UNAVAILABLE:
      return "";
    default:
      return "Could not start webhook forwarding.";
  }
}
