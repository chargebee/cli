/** Ingest URL for CLI and agent feedback. One hardcoded origin; no env override. */
export const CLI_FEEDBACK_URL = "https://apibeehive.chargebee.com/public/api/cli/feedback";

/** Discovery document agents read before posting structured feedback. */
export const AGENT_FEEDBACK_DISCOVERY_URL =
  "https://apibeehive.chargebee.com/.well-known/agent-feedback.json";
