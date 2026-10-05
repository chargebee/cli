import type { Command } from "commander";

import { humanLog, diagnostic, jsonResult, printJson, finishOutput } from "../lib/output.js";
import { FLUSH_COMMAND, spoolPath } from "../lib/telemetry/constants.js";
import { buildBatches, runFlush } from "../lib/telemetry/flush.js";
import { disabledSource, setTelemetryEnabled, type DisableSource } from "../lib/telemetry/optout.js";
import { readRecords, spoolStats } from "../lib/telemetry/spool.js";
import { readState } from "../lib/telemetry/state.js";
import { setCommandGroup } from "./help.js";

export function registerTelemetryCommand(program: Command): void {
  const telemetry = program
    .command("telemetry")
    .description("Manage usage telemetry")
    .action(() => showStatus());

  setCommandGroup(telemetry, "more");

  telemetry
    .command("status")
    .description("Show telemetry status")
    .option("--pending", "Print the spooled-but-unsent events as the JSON request bodies a flush would send")
    .action((opts: { pending?: boolean }) => {
      if (opts.pending) showPending();
      else showStatus();
    });

  telemetry
    .command("enable")
    .description("Enable usage telemetry")
    .action(() => {
      if (setTelemetryEnabled(true)) {
        jsonResult({ enabled: disabledSource() === undefined, disabled_by: disabledSource() ?? null });
        humanLog("  \x1b[32m✓\x1b[0m Telemetry enabled. Thank you for helping improve the CLI.");
      } else {
        diagnostic("  \x1b[31m✗\x1b[0m Could not save the setting (failed to write ~/.chargebee/cli/telemetry.json).");
        diagnostic("    Telemetry is on by default, so it remains enabled. Check the directory's permissions.");
        finishOutput(1, "configuration_write_failed");
        process.exitCode = 1;
      }
    });

  telemetry
    .command("disable")
    .description("Disable usage telemetry")
    .action(() => {
      if (setTelemetryEnabled(false)) {
        jsonResult({ enabled: false, disabled_by: disabledSource() ?? null });
        humanLog("  \x1b[32m✓\x1b[0m Telemetry disabled. No usage data will be collected.");
      } else {
        diagnostic("  \x1b[31m✗\x1b[0m Could not save the setting (failed to write ~/.chargebee/cli/telemetry.json).");
        diagnostic("    Check that ~/.chargebee/cli/ exists and is writable, then retry:");
        diagnostic("      chargebee telemetry disable");
        finishOutput(1, "configuration_write_failed");
        process.exitCode = 1;
      }
    });

  // Hidden background worker: drains the local spool. Spawned detached by the
  // recorder; never shown in help and never itself recorded.
  program
    .command(FLUSH_COMMAND, { hidden: true })
    .description("(internal) flush spooled telemetry")
    .action(async () => {
      await runFlush();
    });
}

/** Human-readable label for `chargebee telemetry status`'s "Disabled by" line. */
function sourceLabel(source: DisableSource): string {
  switch (source) {
    case "DO_NOT_TRACK":
      return "DO_NOT_TRACK environment variable";
    case "CHARGEBEE_CLI_TELEMETRY":
      return "CHARGEBEE_CLI_TELEMETRY environment variable";
    case "CI":
      return "CI environment detected";
    case "state_dir_unwritable":
      return "~/.chargebee/cli is not writable";
    case "state_file":
      return "chargebee telemetry disable";
  }
}

function showStatus(): void {
  const source = disabledSource();
  const disabled = source !== undefined;
  const state = readState();

  if (jsonResult({ enabled: !disabled, disabled_by: source ?? null, anonymous_id: state.anonymous_id || null, pending: spoolStats().count, next_flush_attempt_at: state.next_flush_attempt_at || null })) return;
  humanLog();
  humanLog(`  Telemetry   : ${disabled ? "\x1b[33mdisabled\x1b[0m" : "\x1b[32menabled\x1b[0m"}`);
  if (disabled) humanLog(`  Disabled by : ${sourceLabel(source)}`);
  if (state.anonymous_id) humanLog(`  Install ID  : ${state.anonymous_id}`);
  const { count } = spoolStats();
  if (count > 0) {
    humanLog(`  Pending     : ${count} event${count === 1 ? "" : "s"} queued to send`);
    if (state.next_flush_attempt_at > Date.now()) {
      humanLog(`  Next attempt: ${new Date(state.next_flush_attempt_at).toISOString()}`);
    }
  }
  humanLog();
  humanLog("  Sent        : command name, flag names, outcome, CLI version, OS/arch, the install id above, and your site name.");
  humanLog("  Never sent  : argument values, API keys, customer data or webhook payloads.");
  humanLog("  Learn more  : https://github.com/chargebee/cli/blob/main/TELEMETRY.md");
  humanLog(disabled ? "  Enable with : chargebee telemetry enable" : "  Disable with: chargebee telemetry disable");
  humanLog();
}

/**
 * Print the spooled-but-unsent events as the exact request bodies a flush would
 * POST (see TELEMETRY.md's "Wire shape"), built by the same batching a flush
 * uses, so a user can verify precisely what would be sent without parsing the
 * NDJSON spool file themselves.
 */
function showPending(): void {
  const bodies = buildBatches(readRecords(spoolPath())).map((b) => b.body);
  printJson(bodies);
}
