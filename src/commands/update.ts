import type { Command } from "commander";
import { humanLog, diagnostic, exitCommand, jsonResult } from "../lib/output.js";
import { setCommandGroup } from "./help.js";
import {
  detectInstallMethod,
  fetchLatestRelease,
  normalizeVersion,
  otherPackageManagerUpdateMessage,
  resolveUpdateChannel,
  updateGithub,
  updateNpm,
} from "../lib/update/index.js";

export function registerUpdateCommand(program: Command): void {
  const update = program
    .command("update")
    .alias("upgrade")
    .description("Update the Chargebee CLI to the latest version")
    .option("-f, --force", "Reinstall even if already on the latest version")
    .option(
      "--channel <channel>",
      "Release channel: stable or beta (default: stable, or beta while this copy is a prerelease; env CHARGEBEE_CLI_CHANNEL)",
    )
    .action(async (opts: { force?: boolean; channel?: string }) => {
      const currentVersion = normalizeVersion(program.version() ?? "unknown");
      const channel = resolveUpdateChannel(opts.channel, process.env.CHARGEBEE_CLI_CHANNEL, currentVersion);
      if (!channel) {
        diagnostic(`  Unknown channel "${opts.channel ?? process.env.CHARGEBEE_CLI_CHANNEL}". Use "stable" or "beta".`);
        exitCommand(1);
      }

      humanLog();
      humanLog("  Updating Chargebee CLI");
      humanLog("  ──────────────────────");
      humanLog(`  Current version: ${currentVersion}`);

      // Always resolve the release: the GitHub channel downloads that exact
      // tag, so --force only skips the "already on latest" short-circuit.
      const latest = await fetchLatestRelease(channel);
      if (latest) {
        humanLog(`  Latest version:  ${latest.version}${channel === "beta" ? " (beta channel)" : ""}`);
        if (latest.version === currentVersion && !opts.force) {
          jsonResult({ updated: false, version: currentVersion, channel });
          humanLog();
          humanLog(`  Already on latest version. Use --force to reinstall.`);
          humanLog();
          return;
        }
      } else {
        humanLog(`  (could not check latest version — proceeding)`);
      }
      humanLog();

      const method = detectInstallMethod();
      if (method === "source") {
        diagnostic("  This is a source checkout, not an install.sh or npm copy.");
        humanLog("  Update with git pull, or reinstall from GitHub Releases / npm.");
        humanLog();
        exitCommand(1);
      }

      if (method === "pnpm" || method === "yarn" || method === "bun-global") {
        diagnostic(otherPackageManagerUpdateMessage(method, latest?.version ?? null, channel));
        exitCommand(1);
      }

      if (method === "github") {
        await updateGithub(currentVersion, latest);
      } else {
        updateNpm(currentVersion, latest?.version ?? null, channel);
      }

      humanLog();
      humanLog("  Run `chargebee --version` to confirm.");
      humanLog();
    });

  setCommandGroup(update, "more");
}
