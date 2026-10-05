import { describe, expect, it } from "bun:test";

import {
  AGENT_FEEDBACK_DISCOVERY_URL,
  CLI_FEEDBACK_URL,
} from "../../../../lib/feedback/endpoint.js";

describe("feedback endpoints", () => {
  it("uses the BeeHive host and the headless paths", () => {
    expect(CLI_FEEDBACK_URL).toBe("https://apibeehive.chargebee.com/public/api/cli/feedback");
    expect(AGENT_FEEDBACK_DISCOVERY_URL).toBe(
      "https://apibeehive.chargebee.com/.well-known/agent-feedback.json",
    );
  });
});
