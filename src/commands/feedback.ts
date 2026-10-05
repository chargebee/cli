import type { Command } from "commander";

import { humanLog, jsonResult } from "../lib/output.js";
import { peekActiveSiteName } from "../lib/api/sdk.js";
import {
  formatChargebeeCliVersion,
  submitCliFeedback
} from "../lib/feedback/submit.js";
import { setCommandGroup } from "./help.js";
import { sectionTitle } from "../lib/help-style.js";

/**
 * POST a message to BeeHive. A message is required.
 * The request carries the configured site name when one is available, and never an API key.
 * Callers that are not the CLI POST the same intake. The public help text does not name that host.
 */
export function registerFeedbackCommand(program: Command): void {
  const feedback = program
    .command("feedback")
    .description("Share feedback about the Chargebee CLI")
    .argument("[message]", "Feedback to send")
    .option(
      "--email <address>",
      "Email address for us to contact for resolution or more info. Recommended."
    )
    .addHelpText(
      "after",
      `\nSends feedback message to Chargebee.\n\n${sectionTitle("EXAMPLES")}\n` +
        '  chargebee feedback "list filters are hard to find"\n' +
        '  chargebee feedback "list filters are hard to find" --email you@example.com\n'
    )
    .action(async function (
      this: Command,
      message: string | undefined,
      opts: { email?: string }
    ) {
      const text = message?.trim() ?? "";
      if (!text) {
        throw new Error(
          opts.email
            ? "--email requires a feedback message.\n\n" +
                '  chargebee feedback "what happened" --email you@example.com'
            : "A feedback message is required.\n\n" +
                '  chargebee feedback "what happened"'
        );
      }
      if (text.length > 4000) {
        throw new Error("Feedback must be 4000 characters or fewer.");
      }
      if (opts.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.email)) {
        throw new Error("--email must be an email address.");
      }

      const version = this.parent?.version();
      if (!version) {
        throw new Error(
          "CLI version is unavailable, so feedback was not sent."
        );
      }
      const siteName = await peekActiveSiteName();
      await submitCliFeedback({
        comments: text,
        email: opts.email,
        siteName,
        cliVersion: formatChargebeeCliVersion(version)
      });
      jsonResult({ submitted: true });
      humanLog("Thanks for the feedback! It helps us make the Chargebee CLI better.");
      humanLog(
        opts.email
          ? `We'll follow up at ${opts.email} if needed.`
          : "Want a reply? Send it again with --email you@example.com."
      );
    });

  setCommandGroup(feedback, "more");
}
