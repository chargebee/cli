import type { Command } from "commander";

import { humanLog, diagnostic, exitCommand, jsonResult } from "../lib/output.js";
import { resolveActiveSiteName, resolveApiHost } from "../lib/api/sdk.js";
import { apiBaseURL } from "../lib/config/urls.js";
import {
  findByShortcut,
  listEntries,
  openBrowser,
  resolve,
  shouldOpenBrowser,
} from "../lib/open/index.js";
import { setCommandGroup } from "./help.js";
import { sectionTitle } from "../lib/help-style.js";

export function registerOpenCommand(program: Command): void {
  const open = program
    .command("open [shortcut] [resource-id]")
    .description("Open a dashboard page in a browser")
    .option("-u, --url-only", "Print the URL instead of opening the browser")
    .option("--list", "Show all available shortcuts")
    .addHelpText(
      "after",
      `\nWithout a shortcut, opens the dashboard home.\n\n${sectionTitle("EXAMPLES")}\n` +
        "  chargebee open\n" +
        "  chargebee open customers cust_123\n",
    )
    .action(async (shortcut?: string, resourceId?: string, opts?: Record<string, unknown>) => {
      if (opts?.list) {
        printShortcutList();
        return;
      }

      const target = shortcut ?? "dashboard";
      findByShortcut(target);

      const site = await resolveActiveSiteName();
      if (!site) {
        diagnostic("No site configured — run 'chargebee auth add' first");
        exitCommand(1);
      }
      const baseURL = apiBaseURL(site, await resolveApiHost());
      const url = resolve(target, resourceId ?? "", baseURL);

      if (opts?.urlOnly || !shouldOpenBrowser()) {
        jsonResult({ url, browser_requested: false });
        humanLog(url);
        return;
      }

      openBrowser(url);
      jsonResult({ url, browser_requested: true });
      humanLog(`Opening ${url} in your browser...`);
    });

  setCommandGroup(open, "more");
}

/** Print all registry entries grouped by category, with aliases and ID hints. */
function printShortcutList(): void {
  const entries = listEntries();
  if (jsonResult({ shortcuts: entries })) return;
  let currentCategory = "";

  for (const e of entries) {
    if (e.category !== currentCategory) {
      if (currentCategory) humanLog();
      currentCategory = e.category;
      humanLog(`${currentCategory.charAt(0).toUpperCase()}${currentCategory.slice(1)}:`);
    }

    const aliases = e.aliases.length > 0 ? ` (also: ${e.aliases.join(", ")})` : "";
    const idHint = e.detailPath ? "\t[accepts ID]" : "";
    humanLog(`  ${e.shortcut.padEnd(22)} ${e.description}${aliases}${idHint}`);
  }
}
