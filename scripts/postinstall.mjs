#!/usr/bin/env node
/**
 * npm `postinstall`: records the "npm" install-method marker for a global
 * install and prints onboarding hints. Best-effort only — a failure here
 * must never turn into a non-zero postinstall exit and break `npm install`.
 * No-ops for a local (non -g) install, when scripts are explicitly ignored,
 * or when there is no home directory to write under.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function main() {
  if (process.env.npm_config_ignore_scripts === "true") return;
  if (process.env.npm_config_global !== "true") return;
  if (!process.env.HOME && !process.env.USERPROFILE) return;

  const dir = process.env.CHARGEBEE_CONFIG_DIR || join(homedir(), ".chargebee", "cli");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "install-method"), "npm\n");
  console.log(
    "\n  Using an AI agent? Install the Chargebee CLI skill:\n    chargebee skills add\n  Prefer a shorter command?\n    chargebee alias set\n",
  );
}

try {
  main();
} catch {
  // Marker/hint writing is a convenience; it must never fail the install.
}
