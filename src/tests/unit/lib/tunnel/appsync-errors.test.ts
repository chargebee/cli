import { describe, expect, it } from "bun:test";

import {
  AppSyncErrorCode,
  classifyAppSyncFailure,
  handlerError,
  listenUserMessage,
  parseHandlerError,
} from "../../../../lib/tunnel/appsync-errors.js";

describe("handlerError / parseHandlerError", () => {
  it("round-trips CODE and CODE:detail", () => {
    expect(handlerError("INVALID_CHANNEL")).toBe("INVALID_CHANNEL");
    expect(handlerError("ENABLE_FAILED", 503)).toBe("ENABLE_FAILED:503");
    expect(handlerError("CONTROL_FAILED", "heartbeat:503")).toBe("CONTROL_FAILED:heartbeat:503");
    expect(parseHandlerError("ENABLE_FAILED:503")).toEqual({
      code: "ENABLE_FAILED",
      detail: "503",
    });
    expect(parseHandlerError("INVALID_CHANNEL")).toEqual({ code: "INVALID_CHANNEL" });
  });

  it("does not treat free-form AppSync English as a handler code", () => {
    expect(
      parseHandlerError(
        "You are not authorized to make this call because the lambda invocation timed out.",
      ),
    ).toBeNull();
  });
});

describe("classifyAppSyncFailure", () => {
  it("treats AppSync 401 / UnauthorizedException as opaque APPSYNC_UNAUTHORIZED", () => {
    const timeout = classifyAppSyncFailure({
      type: "connection_error",
      errors: [
        {
          errorType: "UnauthorizedException",
          message:
            "You are not authorized to make this call because the lambda invocation timed out.",
          errorCode: 401,
        },
      ],
    });
    expect(timeout).toMatchObject({
      code: AppSyncErrorCode.APPSYNC_UNAUTHORIZED,
      permanent: true,
      reason: "Could not authorize the listen session.",
    });
    expect(timeout.reason).not.toMatch(/AppSync|UnauthorizedException|lambda/i);

    const rejected = classifyAppSyncFailure({
      type: "subscribe_error",
      errors: [{ errorType: "UnauthorizedException", message: "token expired" }],
    });
    expect(rejected).toMatchObject({
      code: AppSyncErrorCode.APPSYNC_UNAUTHORIZED,
      permanent: true,
    });
  });

  it("parses handler codes on subscribe_error and classifies 5xx as transient", () => {
    const enable401 = classifyAppSyncFailure({
      type: "subscribe_error",
      errors: [{ message: handlerError("ENABLE_FAILED", 401) }],
    });
    expect(enable401).toMatchObject({
      code: "ENABLE_FAILED",
      detail: "401",
      permanent: true,
    });

    const enable503 = classifyAppSyncFailure({
      type: "subscribe_error",
      errors: [{ message: handlerError("ENABLE_FAILED", 503) }],
    });
    expect(enable503).toMatchObject({
      code: "ENABLE_FAILED",
      detail: "503",
      permanent: false,
    });

    expect(
      classifyAppSyncFailure({
        error: handlerError("CONTROL_FAILED", "heartbeat:503"),
      }),
    ).toMatchObject({
      code: "CONTROL_FAILED",
      detail: "heartbeat:503",
      permanent: false,
    });
  });

  it("accepts string-form AppSync errors and keeps handler failures permanent by default", () => {
    expect(classifyAppSyncFailure({ errors: handlerError("INVALID_CHANNEL") })).toMatchObject({
      code: "INVALID_CHANNEL",
      permanent: true,
    });
    expect(classifyAppSyncFailure({ errors: "not a handler code" })).toMatchObject({
      code: AppSyncErrorCode.APPSYNC_ERROR,
      permanent: false,
    });
  });
});

describe("listenUserMessage", () => {
  it("does not name the pipeline or blame the API key for a 401", () => {
    const message = listenUserMessage(AppSyncErrorCode.APPSYNC_UNAUTHORIZED);
    expect(message).toBe("Could not authorize the listen session.");
    expect(message).not.toMatch(/AppSync|authorizer|lambda|configure|API key/i);
  });

  it("renders ENABLE_FAILED with the HTTP status", () => {
    expect(listenUserMessage("ENABLE_FAILED", "401")).toContain("HTTP 401");
    expect(listenUserMessage("ENABLE_FAILED", "401")).not.toMatch(/AppSync/i);
  });

  it("renders every remaining public tunnel error without vendor details", () => {
    expect(listenUserMessage(AppSyncErrorCode.INVALID_CHANNEL)).toBe(
      "This listen session was rejected.",
    );
    expect(listenUserMessage(AppSyncErrorCode.MISSING_DOMAIN)).toBe(
      "The listen session is missing a site.",
    );
    expect(listenUserMessage(AppSyncErrorCode.CONTROL_FAILED)).toBe(
      "Session keepalive against Chargebee failed.",
    );
    expect(listenUserMessage(AppSyncErrorCode.APPSYNC_ERROR)).toBe(
      "The webhook tunnel returned an error.",
    );
    expect(listenUserMessage("UNKNOWN")).toBe("Could not start webhook forwarding.");
  });
});
