import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerFeedbackCommand } from "../../commands/feedback.js";
import { writeConfig } from "../../lib/config/store.js";
import { CLI_FEEDBACK_URL } from "../../lib/feedback/endpoint.js";
import { runCli, setStdoutIsTTY } from "../../lib/test-support/_helpers.js";

describe("feedback", () => {
  const prevConfig = process.env.CHARGEBEE_CONFIG_DIR;
  const prevSite = process.env.CHARGEBEE_SITE;
  const prevKey = process.env.CHARGEBEE_API_KEY;
  const originalFetch = globalThis.fetch;
  let dir: string;
  let restoreStdout: () => void;
  let posted: { url: string; init?: RequestInit }[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-feedback-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    delete process.env.CHARGEBEE_SITE;
    delete process.env.CHARGEBEE_API_KEY;
    restoreStdout = setStdoutIsTTY(false);
    posted = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      posted.push({ url: String(url), init });
      return new Response(JSON.stringify({ receipt: { id: "receipt-1", status: "accepted" } }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    restoreStdout();
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
    if (prevConfig === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prevConfig;
    if (prevSite === undefined) delete process.env.CHARGEBEE_SITE;
    else process.env.CHARGEBEE_SITE = prevSite;
    if (prevKey === undefined) delete process.env.CHARGEBEE_API_KEY;
    else process.env.CHARGEBEE_API_KEY = prevKey;
  });

  it("requires a message and does not open a form", async () => {
    const { stdout, stderr, exitCode } = await runCli(["feedback"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("A feedback message is required");
    expect(stdout).not.toContain("forms.gle");
    expect(stderr).not.toContain("forms.gle");
    expect(posted).toHaveLength(0);
  });

  it("rejects --url-only", async () => {
    const { exitCode, stderr } = await runCli(["feedback", "--url-only"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("unknown option");
  });

  it("does not print the configured site when the message is missing", async () => {
    await writeConfig({ domain: "acme-test" });
    const { stdout, stderr } = await runCli(["feedback"]);
    expect(stdout).not.toContain("acme-test");
    expect(stderr).not.toContain("acme-test");
  });

  it("is listed in root help", async () => {
    const { stdout } = await runCli(["--help"]);
    expect(stdout).toContain("feedback");
  });

  it("help does not name an internal host", async () => {
    const { stdout } = await runCli(["feedback", "--help"]);
    expect(stdout).not.toContain("apibeehive");
  });

  it("posts the message, optional email, and configured site, and never the API key", async () => {
    process.env.CHARGEBEE_SITE = "acme-test";
    process.env.CHARGEBEE_API_KEY = "test_secret_value";

    const { stdout, exitCode } = await runCli([
      "feedback",
      "list filters are hard to find",
      "--email",
      "dev@example.com",
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(
      "Thanks for the feedback! It helps us make the Chargebee CLI better.\n" +
        "We'll follow up at dev@example.com if needed."
    );
    expect(stdout).not.toContain("acme-test");
    expect(stdout).not.toContain("test_secret_value");
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe(CLI_FEEDBACK_URL);
    const headers = posted[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(posted[0].init?.body));
    expect(body).toEqual({
      comments: "list filters are hard to find",
      email: "dev@example.com",
      site_name: "acme-test",
      cli_version: "chargebee_cli_v0.0.0-test",
    });
    expect(JSON.stringify(body)).not.toContain("test_secret_value");
  });

  it("omits site and email when they are not configured", async () => {
    const { stdout, exitCode } = await runCli(["feedback", "something broke"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(
      "Thanks for the feedback! It helps us make the Chargebee CLI better.\n" +
        "Want a reply? Send it again with --email you@example.com."
    );
    const body = JSON.parse(String(posted[0].init?.body));
    expect(body.comments).toBe("something broke");
    expect(body.email).toBeUndefined();
    expect(body.site_name).toBeUndefined();
  });

  it("refuses to send when the CLI version is unavailable", async () => {
    const program = new Command().exitOverride();
    registerFeedbackCommand(program);
    await expect(
      program.parseAsync(["feedback", "something broke"], { from: "user" })
    ).rejects.toThrow("CLI version is unavailable, so feedback was not sent.");
    expect(posted).toHaveLength(0);
  });

  it("rejects --email without a message", async () => {
    const { exitCode, stderr } = await runCli(["feedback", "--email", "dev@example.com"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--email requires a feedback message");
    expect(posted).toHaveLength(0);
  });

  it("rejects a message longer than 4000 characters before sending", async () => {
    const { exitCode, stderr } = await runCli(["feedback", "x".repeat(4001)]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("4000");
    expect(posted).toHaveLength(0);
  });

  it("rejects an invalid email before sending", async () => {
    const { exitCode, stderr } = await runCli(["feedback", "something broke", "--email", "nope"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--email must be an email address");
    expect(posted).toHaveLength(0);
  });

  it("reports a send failure without mentioning a form", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const { exitCode, stderr } = await runCli(["feedback", "something broke"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Could not send feedback");
    expect(stderr).not.toContain("forms.gle");
  });
});
