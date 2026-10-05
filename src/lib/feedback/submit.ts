import { NetworkError } from "../api/sdk.js";
import { CLI_FEEDBACK_URL } from "./endpoint.js";

const HTTP_TIMEOUT_MS = 10_000;

export interface CliFeedbackInput {
  comments: string;
  email?: string;
  siteName?: string;
  /** Already prefixed, for example {@code chargebee_cli_v1.4.0-beta.1}. Sent as {@code cli_version}. */
  cliVersion: string;
}

/** Stored in feedback_source. Includes prerelease tags such as {@code -beta.1}. */
export function formatChargebeeCliVersion(version: string): string {
  return `chargebee_cli_v${version}`;
}

/** The server rejected the body. The message never includes the submitted text. */
export class FeedbackRejectedError extends Error {
  constructor() {
    super("Feedback was rejected. Use a short message and a valid email address.");
    this.name = "FeedbackRejectedError";
  }
}

export class FeedbackRateLimitedError extends Error {
  constructor() {
    super("Too many feedback submissions. Try again in a minute.");
    this.name = "FeedbackRateLimitedError";
  }
}

/**
 * POST one feedback report. Returns the receipt id when the server sends one.
 * Sends comments, optional email, optional site name, and the CLI version.
 * Never sends an API key.
 */
export async function submitCliFeedback(input: CliFeedbackInput): Promise<string> {
  const body: Record<string, string> = {
    comments: input.comments,
    cli_version: input.cliVersion,
  };
  if (input.email) body.email = input.email;
  if (input.siteName) body.site_name = input.siteName;

  let res: Response;
  try {
    res = await fetch(CLI_FEEDBACK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch {
    throw new NetworkError("Could not send feedback.");
  }

  if (res.status === 400) throw new FeedbackRejectedError();
  if (res.status === 429) throw new FeedbackRateLimitedError();
  if (!res.ok) {
    throw new NetworkError("Could not send feedback.");
  }

  try {
    const parsed = (await res.json()) as { receipt?: { id?: unknown } };
    return typeof parsed.receipt?.id === "string" ? parsed.receipt.id : "";
  } catch {
    return "";
  }
}
