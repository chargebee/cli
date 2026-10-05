import { describe, expect, it } from "bun:test";

import { classifyNonSdkError, markUnconfigured, recordTelemetryError, takeTelemetryError } from "../../../../lib/telemetry/error.js";

describe("classifyNonSdkError", () => {
  it("returns unconfigured only when the error was marked", () => {
    expect(classifyNonSdkError(markUnconfigured(new Error("Not configured.")))).toBe(
      "unconfigured",
    );
  });

  it("returns cli_error for ordinary errors", () => {
    expect(classifyNonSdkError(new Error("Not configured."))).toBe("cli_error");
    expect(classifyNonSdkError("network")).toBe("cli_error");
  });
});

describe("recordTelemetryError", () => {
  it("first write wins and take clears the slot", () => {
    takeTelemetryError();
    recordTelemetryError("usage");
    recordTelemetryError("cli_error");
    expect(takeTelemetryError()).toBe("usage");
    expect(takeTelemetryError()).toBeUndefined();
  });
});
