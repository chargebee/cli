#!/usr/bin/env node
// Poll the registry with npm's configured authentication. A successful publish
// can precede read availability. Never retry an install or its lifecycle scripts.
import { spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

const [spec, mode = "version"] = process.argv.slice(2);
const expected = spec?.slice(spec.lastIndexOf("@") + 1);
const attempts = Number(process.env.NPM_RELEASE_ATTEMPTS ?? 60);
const delayMs = Number(process.env.NPM_RELEASE_DELAY_MS ?? 10_000);

try {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(spec ?? "") || !["version", "readme"].includes(mode)) {
    throw new Error("usage: wait-for-npm-release.mjs <package@exact-version> [version|readme]");
  }
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 60 || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
    throw new Error("Invalid NPM_RELEASE_ATTEMPTS (1–60) or NPM_RELEASE_DELAY_MS (0–60000)");
  }

  let ready = false;
  let reason = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    // cache add exercises the installation resolver and fetches the tarball
    // without executing lifecycle scripts. npm view alone uses full metadata,
    // which can be visible before the abbreviated install metadata is updated.
    const command = mode === "version" ? ["cache", "add", spec, "--ignore-scripts"] : ["view", spec, "version", "readme"];
    const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", [
      ...command,
      "--json", "--prefer-online", "--fetch-retries=0", "--fetch-timeout=15000",
    ], { encoding: "utf8", timeout: 20_000, shell: process.platform === "win32" });
    if (result.error && result.error.code !== "ETIMEDOUT") throw result.error;
    // Do not echo registry bodies or npm diagnostics: they can contain private
    // registry URLs. Print only known error codes and an actionable summary.
    const errorCode = /\b(E401|E403|E404|ETARGET|ENEEDAUTH|EOTP)\b/.exec(result.stderr ?? "")?.[1];
    if (["E401", "E403", "ENEEDAUTH", "EOTP"].includes(errorCode)) {
      throw new Error(`${errorCode}: npm authentication/access failed. Check the token's package read permission.`);
    }
    if (result.status === 0 && mode === "version") {
      ready = true;
    } else if (result.status === 0) {
      let data;
      try { data = JSON.parse(result.stdout); } catch { /* Retry incomplete metadata. */ }
      // npm view emits just the version string when no requested README field
      // exists. The version is still published; only the index is missing.
      const version = typeof data === "string" ? data : data?.version;
      const readme = data?.readme;
      ready = version === expected && typeof readme === "string" &&
        readme.trim().length > 0 && !readme.includes("ERROR: No README data found!");
      reason = version !== expected ? "exact version is not visible" : "README metadata is missing";
    } else {
      reason = errorCode ?? "registry request failed or timed out";
    }
    if (ready) break;
    console.log(`Waiting for npm ${mode} (${attempt}/${attempts}): ${reason}`);
    if (attempt < attempts) await setTimeout(delayMs);
  }
  if (!ready) {
    if (mode === "readme" && reason === "README metadata is missing") {
      throw new Error(`npm README metadata is missing for ${spec}, although the version is published. Check npm's README indexing; this does not mean the published tarball lacks README.md. Do not republish the same version.`);
    }
    throw new Error(`npm ${mode} unavailable for ${spec}: ${reason}. Check registry availability and token read access; E404 can also mean a private package is inaccessible.`);
  }
  console.log(`Verified npm ${mode} for ${spec}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
