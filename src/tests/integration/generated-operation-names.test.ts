import { describe, expect, it } from "bun:test";

import { buildProgram } from "../../program.js";
import { runCli } from "../../lib/test-support/_helpers.js";

const previousNames: Record<string, Record<string, string>> = {
  alert: {
    "application-alerts-for-subscription": "application_alerts-for-subscription",
  },
  "alert-status": {
    "alert-statuses-for-alert": "alert_statuses-for-alert",
    "alert-statuses-for-subscription": "alert_statuses-for-subscription",
  },
  "payment-voucher": {
    "payment-vouchers-for-customer": "payment_vouchers-for-customer",
    "payment-vouchers-for-invoice": "payment_vouchers-for-invoice",
  },
  "omnichannel-subscription": {
    "omnichannel-transactions-for-omnichannel-subscription":
      "omnichannel_transactions-for-omnichannel-subscription",
  },
};

describe("generated API operation names", () => {
  it("uses kebab case for every operation and retains published mixed-name aliases", () => {
    const program = buildProgram("test");
    const resources = program.commands.filter((command) =>
      command.commands.some((operation) => operation.options.some((option) => option.long === "--data"))
    );
    const operations = resources.flatMap((resource) => resource.commands);

    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) {
      expect(operation.name()).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }

    for (const [resourceName, names] of Object.entries(previousNames)) {
      const resource = resources.find((command) => command.name() === resourceName);
      expect(resource).toBeDefined();
      for (const [canonical, previous] of Object.entries(names)) {
        const operation = resource!.commands.find((command) => command.name() === canonical);
        expect(operation?.aliases()).toContain(previous);
      }
    }
  });

  it("runs each command through its canonical and previous name", async () => {
    for (const [resource, names] of Object.entries(previousNames)) {
      for (const [canonicalName, previousName] of Object.entries(names)) {
        const canonical = await runCli([resource, canonicalName, "-s", "list"]);
        const previous = await runCli([resource, previousName, "-s", "list"]);
        expect(canonical.exitCode).toBe(0);
        expect(previous.exitCode).toBe(0);
        expect(previous.stdout).toBe(canonical.stdout);
      }
    }
  });
});
