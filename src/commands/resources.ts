import type { Command } from "commander";

import { humanLog, jsonResult } from "../lib/output.js";
import { formatColumns, getCommandsByGroup } from "./help.js";

/** Catalog listing only — not a namespace. API calls stay `chargebee customer list`. */
export function registerResourcesCommand(program: Command): void {
  program
    .command("resources")
    .description("List all callable API resource commands")
    .action(() => {
      const names = getCommandsByGroup(program, "resource")
        .map((c) => c.name())
        .sort();
      if (jsonResult({ resources: names })) return;
      humanLog(`API resources (${names.length}):`);
      humanLog(formatColumns(names).join("\n"));
      humanLog("");
      humanLog("  chargebee <resource> --help     List operations");
      humanLog("  chargebee docs <resource>       Browse API docs");
    });
}
