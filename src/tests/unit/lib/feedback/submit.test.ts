import { afterEach, describe, expect, it } from "bun:test";

import { NetworkError } from "../../../../lib/api/sdk.js";
import { CLI_FEEDBACK_URL } from "../../../../lib/feedback/endpoint.js";
import {
  FeedbackRateLimitedError,
  FeedbackRejectedError,
  formatChargebeeCliVersion,
  submitCliFeedback,
} from "../../../../lib/feedback/submit.js";

const VERSION = "chargebee_cli_v1.4.0-beta.1";

describe("formatChargebeeCliVersion", () => {
  it("prefixes release and beta versions", () => {
    expect(formatChargebeeCliVersion("1.4.0")).toBe("chargebee_cli_v1.4.0");
    expect(formatChargebeeCliVersion("1.4.0-beta.1")).toBe("chargebee_cli_v1.4.0-beta.1");
  });
});

describe("submitCliFeedback", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the receipt id and sends only the feedback fields", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      seen = { url: String(url), init };
      return new Response(JSON.stringify({ receipt: { id: "abc" } }), { status: 201 });
    }) as unknown as typeof fetch;

    const id = await submitCliFeedback({
      comments: "hello",
      email: "dev@example.com",
      siteName: "acme-test",
      cliVersion: VERSION,
    });

    expect(id).toBe("abc");
    expect(seen?.url).toBe(CLI_FEEDBACK_URL);
    expect(JSON.parse(String(seen?.init?.body))).toEqual({
      comments: "hello",
      email: "dev@example.com",
      site_name: "acme-test",
      cli_version: VERSION,
    });
    const headers = seen?.init?.headers as Record<string, string>;
    expect(Object.keys(headers)).toEqual(["Content-Type"]);
  });

  it("omits optional fields and accepts a body with no receipt id", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 201 })) as unknown as typeof fetch;
    const id = await submitCliFeedback({ comments: "hello", cliVersion: VERSION });
    expect(id).toBe("");
  });

  it("rejects a 400 without reading the submitted text back", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "secret comment" }), { status: 400 })) as unknown as typeof fetch;
    await expect(submitCliFeedback({ comments: "secret comment", cliVersion: VERSION })).rejects.toBeInstanceOf(
      FeedbackRejectedError,
    );
  });

  it("reports rate limiting on 429", async () => {
    globalThis.fetch = (async () => new Response("busy", { status: 429 })) as unknown as typeof fetch;
    await expect(submitCliFeedback({ comments: "hello", cliVersion: VERSION })).rejects.toBeInstanceOf(
      FeedbackRateLimitedError,
    );
  });

  it("returns no receipt id when the success body is not JSON", async () => {
    globalThis.fetch = (async () =>
      new Response("not-json", { status: 201 })) as unknown as typeof fetch;
    const id = await submitCliFeedback({ comments: "hello", cliVersion: VERSION });
    expect(id).toBe("");
  });

  it("reports a non-success status as a network error", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(submitCliFeedback({ comments: "hello", cliVersion: VERSION })).rejects.toBeInstanceOf(NetworkError);
  });

  it("reports a transport failure as a network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connect");
    }) as unknown as typeof fetch;
    await expect(submitCliFeedback({ comments: "hello", cliVersion: VERSION })).rejects.toBeInstanceOf(NetworkError);
  });
});
