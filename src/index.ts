#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildProgram } from "./program.js";
import { installFatalHandlers, runProgram } from "./lib/cli-errors.js";
import { installTelemetry } from "./lib/telemetry/index.js";
import { setClientIdentifier } from "./lib/api/sdk.js";
import { cleanupStaleBinary, normalizeVersion } from "./lib/update/index.js";

/**
 * Resolve the CLI version. Production builds (npm bundle / compiled binary)
 * inject `process.env.VERSION` at build time. In dev (`bun src/index.ts`) it's
 * unset, so fall back to reading the package.json version. The compiled
 * binary's VERSION comes from a release tag (`v1.2.3`) while the npm build's
 * comes from `package.json` (`1.2.3`); normalise both to one format so every
 * consumer (`--version`, the SDK User-Agent, telemetry) prints and compares
 * the same string regardless of install channel.
 */
function resolveVersion(): string {
  if (process.env.VERSION) return normalizeVersion(process.env.VERSION);
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf-8"),
    ) as { version?: string };
    return normalizeVersion(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

const VERSION = resolveVersion();

// Identify this process in the SDK User-Agent (`chargebee-cli <version>`).
setClientIdentifier(`chargebee-cli ${VERSION}`);

// A Windows self-update leaves the previous exe as `chargebee.exe.old`.
cleanupStaleBinary();

const program = buildProgram(VERSION);
installTelemetry(program, VERSION);

installFatalHandlers();
await runProgram(program, process.argv, "node");
