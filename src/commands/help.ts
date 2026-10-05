import type { Command } from "commander";

import { peekActiveSiteSync } from "../lib/config/store.js";
import { sectionTitle } from "../lib/help-style.js";
import { displayWidth, renderBox } from "../lib/ui/box.js";

/** Featured API resources on root help (Stripe-style progressive disclosure). */
export const FEATURED_RESOURCES = [
  "customer",
  "subscription",
  "invoice",
  "item",
  "item-price",
] as const;

export function renderHelp(program: Command, _version: string): string {
  const lines: string[] = [];
  const nameW = 14;

  lines.push("Chargebee CLI — Build with Chargebee from the terminal");
  lines.push("");
  lines.push(sectionTitle("USAGE"));
  lines.push("  chargebee <command> [subcommand] [options]");
  lines.push("  chargebee <resource> <operation> [id] [options]");
  lines.push("");

  lines.push(renderQuickStart());
  lines.push("");

  lines.push(sectionTitle("CORE"));
  for (const cmd of orderedGroup(program, "core", ["auth", "login", "listen", "docs", "skills"])) {
    lines.push(`  ${cmd.name().padEnd(nameW)} ${cmd.description()}`);
  }
  lines.push("");

  const resourceCmds = getCommandsByGroup(program, "resource");
  const byName = new Map(resourceCmds.map((c) => [c.name(), c]));
  lines.push(sectionTitle("API"));
  for (const name of FEATURED_RESOURCES) {
    const cmd = byName.get(name);
    if (!cmd) continue;
    lines.push(`  ${name.padEnd(nameW)} ${cmd.description()}`);
  }
  lines.push("");
  lines.push('  These are the most used. Run "chargebee resources" for the full list.');
  lines.push("");

  lines.push(sectionTitle("MORE"));
  for (const cmd of orderedGroup(program, "more", ["open", "update", "feedback", "alias", "telemetry"])) {
    lines.push(`  ${cmd.name().padEnd(nameW)} ${cmd.description()}`);
  }
  lines.push("");

  lines.push(sectionTitle("OPERATION FLAGS (any API command)"));
  lines.push(flag("-d, --data <key=value>", "Request parameter; repeat for more"));
  lines.push(flag("-s, --code-sample <lang>", "Print SDK code instead of calling the API"));
  lines.push(flag("", "Languages: curl, python, nodejs, go, ruby,"));
  lines.push(flag("", "java, php, dotnet"));
  lines.push("");

  lines.push(sectionTitle("SITE FLAGS (API commands, open, listen)"));
  lines.push(flag("--use-profile <profile>", "Run this command with a named profile"));
  lines.push("");

  lines.push(sectionTitle("GLOBAL FLAGS"));
  lines.push(flag("--json", "Structured JSON output; no interactive prompts"));
  lines.push(flag("-v, --version", "Print the CLI version"));
  lines.push(flag("-h, --help", "Show help"));
  lines.push("");

  lines.push(sectionTitle("EXAMPLES"));
  lines.push("  chargebee customer list -d limit=5");
  lines.push("  chargebee customer retrieve cus_123");
  lines.push("  chargebee customer create -d email=jane@example.com");
  lines.push("  chargebee customer create -d email=jane@example.com -s python");
  lines.push("");

  lines.push(sectionTitle("LEARN MORE"));
  lines.push(`  ${"API reference".padEnd(nameW)} https://apidocs.chargebee.com/`);
  lines.push(`  ${"CLI source".padEnd(nameW)} https://github.com/chargebee/cli`);
  lines.push("");

  lines.push("Write operations are blocked on live sites; use a test site to change data.");
  lines.push('Run "chargebee <command> --help" for details.');

  return lines.join("\n");
}

/** Flag rows share one description column across every flag section. */
function flag(name: string, description: string): string {
  return `  ${name.padEnd(24)}  ${description}`;
}

function orderedGroup(program: Command, groupId: string, order: string[]): Command[] {
  const cmds = getCommandsByGroup(program, groupId);
  const byName = new Map(cmds.map((c) => [c.name(), c]));
  const out: Command[] = [];
  const seen = new Set<string>();
  for (const n of order) {
    const c = byName.get(n);
    if (c) {
      out.push(c);
      seen.add(n);
    }
  }
  for (const c of cmds) {
    if (!seen.has(c.name())) out.push(c);
  }
  return out;
}

/**
 * Lay out a list of names in a compact, sorted, multi-column grid (ls-style).
 *
 * Column-major fill (alphabetical reads top-to-bottom within each column) and
 * per-column widths, so one unusually long name doesn't blow up every column.
 * Picks the largest column count whose total width fits the terminal.
 */
export function formatColumns(items: string[], indent = "  "): string[] {
  if (items.length === 0) return [];
  const maxWidth = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 100;
  const gap = 2;
  const usable = Math.max(20, maxWidth - indent.length);

  for (let cols = Math.min(items.length, 8); cols >= 1; cols--) {
    const rows = Math.ceil(items.length / cols);
    const colWidths: number[] = [];
    let total = 0;
    for (let c = 0; c < cols; c++) {
      let w = 0;
      for (let r = 0; r < rows; r++) {
        const idx = c * rows + r;
        if (idx < items.length) w = Math.max(w, items[idx].length);
      }
      colWidths.push(w);
      total += w + (c < cols - 1 ? gap : 0);
    }
    if (total <= usable || cols === 1) {
      const out: string[] = [];
      for (let r = 0; r < rows; r++) {
        let line = indent;
        for (let c = 0; c < cols; c++) {
          const idx = c * rows + r;
          if (idx < items.length) {
            line += c < cols - 1 ? items[idx].padEnd(colWidths[c] + gap) : items[idx];
          }
        }
        out.push(line.replace(/\s+$/, ""));
      }
      return out;
    }
  }
  return [];
}

function renderQuickStart(): string {
  const auth = peekActiveSiteSync();
  if (auth) {
    const site = displayWidth(auth) > 36 ? `${[...auth].slice(0, 33).join("")}...` : auth;
    return renderBox("Quick Start", [
      ` ✓  Connected to ${site}`,
      " 1. chargebee customer list      Try an API command",
      " 2. chargebee docs customer      Browse live API docs",
      " 3. chargebee skills add         Install agent skills",
    ]);
  }
  return renderBox("Quick Start", [
    " 1. chargebee auth add            Connect your site",
    " 2. chargebee customer list       Try an API command",
    " 3. chargebee skills add          Install agent skills",
  ]);
}

/**
 * Metadata tag for grouping commands — stored on the command object.
 * A plain string key (not a Symbol) so it survives bundling/minification, where
 * a module-local Symbol could otherwise be duplicated and fail identity checks.
 */
const GROUP_KEY = "__chargebeeCommandGroup";

export function setCommandGroup(cmd: Command, group: string): void {
  (cmd as any)[GROUP_KEY] = group;
}

export function getCommandGroup(cmd: Command): string | undefined {
  return (cmd as any)[GROUP_KEY];
}

export function getCommandsByGroup(program: Command, groupId: string): Command[] {
  return program.commands.filter((cmd) => getCommandGroup(cmd) === groupId);
}
