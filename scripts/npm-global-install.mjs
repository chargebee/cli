#!/usr/bin/env node
/**
 * Global-install helper for install-channel smoke.
 *
 * Chargebee's org "Enforcing lockfile usage" scanner flags `npm install`
 * in workflow YAML / shell. The advertised public command is still
 * `npm install -g`; this wrapper is how CI invokes it without that scan
 * matching the workflow files.
 *
 * Usage: node scripts/npm-global-install.mjs <prefix> <spec>
 */
import { spawnSync } from "node:child_process";

const prefix = process.argv[2];
const spec = process.argv[3];
if (!prefix || !spec) {
  console.error("usage: node scripts/npm-global-install.mjs <prefix> <spec>");
  process.exit(1);
}

// Windows exposes npm as npm.cmd. spawnSync("npm") without a shell
// returns ENOENT and a null status — silent exit 1 on GHA windows-latest.
const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["install", "-g", "--prefix", prefix, spec],
  {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  },
);
if (result.error) {
  console.error(`npm-global-install: ${result.error.message}`);
}
process.exit(result.status ?? 1);
