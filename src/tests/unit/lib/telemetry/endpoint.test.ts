import { describe, expect, it } from "bun:test";

import { TELEMETRY_URL } from "../../../../lib/telemetry/endpoint.js";

describe("TELEMETRY_URL", () => {
  it("uses the production HTTPS ingest URL", () => {
    expect(TELEMETRY_URL).toBe(
      "https://apibeehive.chargebee.com/public/api/analytics/cli/event-ingestion",
    );
  });
});
