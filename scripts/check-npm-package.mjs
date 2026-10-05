#!/usr/bin/env node
// Validate npm's actual packing list after build:npm, before publishing.
import { readFileSync } from "node:fs";

try {
  const [packed] = JSON.parse(readFileSync(0, "utf8"));
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  if (packed.name !== pkg.name || packed.version !== pkg.version) {
    throw new Error("Packed name/version does not match package.json");
  }
  const readme = readFileSync("README.md", "utf8");
  if (!readme.trim()) throw new Error("README.md is empty");
  for (const path of ["README.md", pkg.bin.chargebee]) {
    if (!packed.files.some((file) => file.path === path && file.size > 0)) {
      throw new Error(`Missing or empty package file: ${path}`);
    }
  }
  console.log(`Verified ${packed.name}@${packed.version}: README.md and CLI entry point are packaged.`);
} catch (error) {
  console.error(`npm package check: ${error.message}`);
  process.exitCode = 1;
}
