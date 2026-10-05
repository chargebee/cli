import { describe, expect, it } from "bun:test";

import { maskApiKey } from "../../../../lib/config/mask.js";

describe("maskApiKey", () => {
  it("keeps only the test_ kind prefix", () => {
    expect(maskApiKey("test_abc123xyz")).toBe("test_…");
    expect(maskApiKey("TEST_abc")).toBe("test_…");
  });

  it("keeps only the live_ kind prefix", () => {
    expect(maskApiKey("live_abc123xyz")).toBe("live_…");
  });

  it("does not leak other key bytes", () => {
    expect(maskApiKey("sk_secret")).toBe("…");
    expect(maskApiKey("ab")).toBe("…");
    expect(maskApiKey("")).toBe("…");
  });
});
