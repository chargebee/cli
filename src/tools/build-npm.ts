#!/usr/bin/env bun
/**
 * Builds the Node-compatible npm distribution.
 *
 * Produces a single self-contained `dist/index.js` (all dependencies bundled,
 * embedded docs/skill assets inlined) that runs under plain Node.js — no Bun
 * runtime and no installed dependencies required by consumers.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve("dist/index.js");

const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf-8")) as { version: string };
const version = process.env.VERSION ?? pkg.version;

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  minify: true,
  define: {
    "process.env.VERSION": JSON.stringify(version),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Force a Node shebang (strip whatever the bundler emitted) and make executable.
let code = readFileSync(OUT, "utf-8");
code = code.replace(/^#![^\n]*\n/, "");
writeFileSync(OUT, `#!/usr/bin/env node\n${code}`);
chmodSync(OUT, 0o755);

console.log(`Built dist/index.js for Node (version ${version})`);
