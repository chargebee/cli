import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { handleSdkError, printResult } from "../../../../lib/api/print.js";
import { markUnconfigured, takeTelemetryError } from "../../../../lib/telemetry/error.js";

const SDK_ENVELOPE = {
  customer: { id: "cust_123", email: "a@b.com" },
  headers: {
    "content-type": "application/json;charset=utf-8",
    server: "ChargeBee",
  },
  httpStatusCode: 200,
  isIdempotencyReplayed: false,
};

describe("printResult", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    stderrSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("outputs pretty-printed JSON by default", () => {
    const data = { customer: { id: "cust_123", email: "a@b.com" } };
    printResult(data);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
  });

  it("passes through non-object values unchanged", () => {
    printResult("raw string");
    expect(logSpy).toHaveBeenCalledWith('"raw string"');
  });

  it("handles null gracefully", () => {
    printResult(null);
    expect(logSpy).toHaveBeenCalledWith("null");
  });

  it("strips SDK HTTP transport fields from default stdout", () => {
    printResult({ ...SDK_ENVELOPE });
    const output = logSpy.mock.calls[0]?.[0] as string;
    expect(JSON.parse(output)).toEqual({ customer: { id: "cust_123", email: "a@b.com" } });
    expect(output).not.toContain("headers");
    expect(output).not.toContain("httpStatusCode");
    expect(output).not.toContain("isIdempotencyReplayed");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("does not mutate the original SDK result", () => {
    const result = { ...SDK_ENVELOPE, headers: { ...SDK_ENVELOPE.headers } };
    printResult(result);
    expect(result.headers).toEqual(SDK_ENVELOPE.headers);
    expect(result.httpStatusCode).toBe(200);
  });

  it("keeps list pagination and drops transport fields", () => {
    printResult({
      list: [{ customer: { id: "c1" } }],
      next_offset: "abc",
      headers: { server: "ChargeBee" },
      httpStatusCode: 200,
      isIdempotencyReplayed: false,
    });
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toEqual({
      list: [{ customer: { id: "c1" } }],
      next_offset: "abc",
    });
  });

  it("prints a JSON-array list cursor as an array", () => {
    const cursor = '["1788773014000","73645044"]';
    const result = {
      list: [{ customer: { id: "c1" } }],
      next_offset: cursor,
    };
    printResult(result);
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toEqual({
      list: [{ customer: { id: "c1" } }],
      next_offset: ["1788773014000", "73645044"],
    });
    expect(result.next_offset).toBe(cursor);
  });

  it("leaves a non-array cursor string unchanged", () => {
    printResult({
      list: [],
      next_offset: "[not-json",
    });
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string).next_offset).toBe("[not-json");

    printResult({ next_offset: '{"page":1}' });
    expect(JSON.parse(logSpy.mock.calls[1]?.[0] as string).next_offset).toBe('{"page":1}');
  });

  it("prints an array result unchanged", () => {
    printResult([{ id: "c1" }]);
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] as string)).toEqual([{ id: "c1" }]);
  });
});

describe("handleSdkError", () => {
  let errorSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    exitSpy = spyOn(process, "exit").mockImplementation((() => {}) as never);
    takeTelemetryError();
  });

  afterEach(() => {
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("prints pretty error JSON and exits 1 for SDK errors", () => {
    const sdkErr = { http_status_code: 400, error_code: "param_wrong", message: "bad param" };
    try { handleSdkError(sdkErr); } catch { /* exit is mocked */ }
    expect(errorSpy).toHaveBeenCalledWith(JSON.stringify(sdkErr, null, 2));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("strips headers from SDK errors and keeps the API error body", () => {
    const sdkErr = {
      http_status_code: 404,
      error_code: "resource_not_found",
      message: "not found",
      headers: { server: "ChargeBee", "content-type": "application/json" },
    };
    try { handleSdkError(sdkErr); } catch { /* exit is mocked */ }
    const printed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);
    expect(printed).toEqual({
      http_status_code: 404,
      error_code: "resource_not_found",
      message: "not found",
    });
    expect(sdkErr.headers).toEqual({ server: "ChargeBee", "content-type": "application/json" });
  });

  it("prints a clean message and exits 1 for non-SDK errors (no rethrow)", () => {
    const err = new Error("network failure");
    expect(() => handleSdkError(err)).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith("network failure");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("appends the cause code for a Node fetch-failed TypeError and exits with the network code", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND acme-test.chargebee.com"), { code: "ENOTFOUND" });
    const err = new TypeError("fetch failed", { cause });
    handleSdkError(err);
    expect(errorSpy).toHaveBeenCalledWith("fetch failed (ENOTFOUND)");
    expect(exitSpy).toHaveBeenCalledWith(7);
  });

  it("appends the cause message when the cause has no error code", () => {
    const cause = new Error("self-signed certificate in certificate chain");
    const err = new TypeError("fetch failed", { cause });
    handleSdkError(err);
    expect(errorSpy).toHaveBeenCalledWith("fetch failed (self-signed certificate in certificate chain)");
  });

  it("prints only the message when there is no cause", () => {
    handleSdkError(new Error("plain failure"));
    expect(errorSpy).toHaveBeenCalledWith("plain failure");
  });

  it("appends the error's own code for a Bun fetch failure (no cause)", () => {
    const err = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
      code: "ConnectionRefused",
    });
    handleSdkError(err);
    expect(errorSpy).toHaveBeenCalledWith("Unable to connect. Is the computer able to access the url? (ConnectionRefused)");
  });

  it("does not print stack frames for non-SDK errors", () => {
    const err = new Error('Invalid API host "staging"');
    err.stack =
      'Error: Invalid API host "staging"\n    at parseHost (/x/host.ts:98:13)\n    at setHostOverride (/x/sdk.ts:42:19)';
    handleSdkError(err);
    const printed = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(printed).toBe('Invalid API host "staging"');
    expect(printed).not.toContain("at parseHost");
    expect(printed).not.toContain("host.ts");
  });

  it("invites a bug report only for an unexpected failure", () => {
    handleSdkError(new Error("cannot read properties of undefined"), { unexpected: true });
    const printed = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(printed).toContain("chargebee feedback");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("stays quiet about feedback for handled, unconfigured, and network failures", async () => {
    const { NetworkError } = await import("../../../../lib/api/sdk.js");
    handleSdkError(new Error("plain failure"));
    handleSdkError(markUnconfigured(new Error("Not configured.")), { unexpected: true });
    handleSdkError(new NetworkError('Could not reach "acme-test": ENOTFOUND.'), { unexpected: true });
    const printed = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(printed).not.toContain("chargebee feedback");
  });

  it("records unconfigured for marked errors and exits with the unconfigured code", () => {
    handleSdkError(markUnconfigured(new Error("Not configured.")));
    expect(takeTelemetryError()).toBe("unconfigured");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("exits with the invalid-credentials code for a 401 SDK error", () => {
    try { handleSdkError({ http_status_code: 401, message: "unauthorized" }); } catch { /* exit is mocked */ }
    expect(exitSpy).toHaveBeenCalledWith(4);
  });

  it("exits with the not-found code for a 404 SDK error", () => {
    try { handleSdkError({ http_status_code: 404, message: "no such resource" }); } catch { /* exit is mocked */ }
    expect(exitSpy).toHaveBeenCalledWith(5);
  });

  it("exits with the network code for a NetworkError", async () => {
    const { NetworkError } = await import("../../../../lib/api/sdk.js");
    handleSdkError(new NetworkError("Could not reach \"acme-test\": ENOTFOUND."));
    expect(exitSpy).toHaveBeenCalledWith(7);
  });

  it("writes PC1 hint for configuration_incompatible error code", () => {
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    const sdkErr = { http_status_code: 422, error_code: "configuration_incompatible" };
    try { handleSdkError(sdkErr); } catch { /* swallow */ }
    const writes = stderrSpy.mock.calls.map((c) => c[0] as string).join("");
    expect(writes).toContain("PC1");
    stderrSpy.mockRestore();
  });

  it("writes PC1 hint for pc1_to_pc2_error error code", () => {
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    const sdkErr = { http_status_code: 422, error_code: "pc1_to_pc2_error" };
    try { handleSdkError(sdkErr); } catch { /* swallow */ }
    const writes = stderrSpy.mock.calls.map((c) => c[0] as string).join("");
    expect(writes).toContain("PC1");
    stderrSpy.mockRestore();
  });

  it("writes PC2 hint for pc2_to_pc1_error error code", () => {
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    const sdkErr = { http_status_code: 422, error_code: "pc2_to_pc1_error" };
    try { handleSdkError(sdkErr); } catch { /* swallow */ }
    const writes = stderrSpy.mock.calls.map((c) => c[0] as string).join("");
    expect(writes).toContain("PC2");
    stderrSpy.mockRestore();
  });

  it("prints a clear message and exits with the network code for the SDK's own timeout error", () => {
    const prevTimeout = process.env.CHARGEBEE_CLI_TIMEOUT_MS;
    delete process.env.CHARGEBEE_CLI_TIMEOUT_MS;
    const sdkErr = {
      message: "io_error",
      type: "timeout",
      http_status_code: 504,
      error_code: "request aborted due to timeout.",
      headers: null,
    };
    try { handleSdkError(sdkErr); } catch { /* exit is mocked */ }
    expect(errorSpy).toHaveBeenCalledWith(
      "Request timed out after 30s; set CHARGEBEE_CLI_TIMEOUT_MS to raise it.",
    );
    expect(exitSpy).toHaveBeenCalledWith(7);
    if (prevTimeout === undefined) delete process.env.CHARGEBEE_CLI_TIMEOUT_MS;
    else process.env.CHARGEBEE_CLI_TIMEOUT_MS = prevTimeout;
  });

  it("does not print the raw timeout JSON body", () => {
    const sdkErr = { message: "io_error", type: "timeout", http_status_code: 504, headers: null };
    try { handleSdkError(sdkErr); } catch { /* exit is mocked */ }
    const printed = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(printed).not.toContain("io_error");
  });

  it("surfaces Retry-After for a 429 and exits with the generic error code", () => {
    const sdkErr = {
      http_status_code: 429,
      error_code: "api_request_limit_exceeded",
      message: "Too many requests",
      headers: { "retry-after": "7" },
    };
    try { handleSdkError(sdkErr); } catch { /* exit is mocked */ }
    expect(errorSpy).toHaveBeenCalledWith("Rate limited by Chargebee; retry after 7 seconds.");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("falls back to the API's message for a 429 with no Retry-After header", () => {
    const sdkErr = {
      http_status_code: 429,
      error_code: "api_request_limit_exceeded",
      message: "Too many requests",
      headers: {},
    };
    try { handleSdkError(sdkErr); } catch { /* exit is mocked */ }
    expect(errorSpy).toHaveBeenCalledWith("Rate limited by Chargebee: Too many requests");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
