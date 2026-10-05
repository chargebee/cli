#!/usr/bin/env bun
/**
 * Compiles the standalone binary.
 *
 * Default: one binary for the host platform at `./chargebee-cli`. `--all`
 * cross-compiles the five release artifacts into `dist/`; `--target=<t>` builds
 * just one of them (CI fans these out across runners).
 *
 * The version is baked in via `process.env.VERSION` — without it the binary
 * reports 0.0.0, which `chargebee update` then compares against releases.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BINARY = "chargebee-cli";

/** Release artifacts, named the way install.sh and install.ps1 expect. */
const TARGETS = [
  { target: "bun-darwin-arm64", outfile: `dist/${BINARY}-darwin-arm64` },
  { target: "bun-darwin-x64", outfile: `dist/${BINARY}-darwin-x64` },
  { target: "bun-linux-arm64", outfile: `dist/${BINARY}-linux-arm64` },
  { target: "bun-linux-x64", outfile: `dist/${BINARY}-linux-x64` },
  { target: "bun-windows-x64", outfile: `dist/${BINARY}-windows-x64.exe` },
] as const;

const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf-8")) as { version: string };
const version = process.env.VERSION ?? pkg.version;

async function compile(outfile: string, target?: string): Promise<void> {
  const args = [
    "build",
    "--compile",
    "--minify",
    "src/index.ts",
    "--outfile",
    outfile,
    "--define",
    `process.env.VERSION='${version}'`,
    ...(target ? [`--target=${target}`] : []),
  ];
  const proc = Bun.spawn(["bun", ...args], { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) process.exit(1);
}

const only = process.argv.find((a) => a.startsWith("--target="))?.slice("--target=".length);
const outfile = process.argv.find((a) => a.startsWith("--outfile="))?.slice("--outfile=".length);

if (outfile) {
  await compile(outfile, only);
  console.log(`Built ${outfile} (version ${version})`);
} else if (only) {
  const match = TARGETS.find((t) => t.target === only);
  if (!match) {
    console.error(`Unknown target "${only}". Known: ${TARGETS.map((t) => t.target).join(", ")}`);
    process.exit(1);
  }
  await compile(match.outfile, match.target);
  console.log(`Built ${match.outfile} (version ${version})`);
} else if (process.argv.includes("--all")) {
  for (const { target, outfile } of TARGETS) await compile(outfile, target);
  console.log(`Built ${TARGETS.length} binaries in dist/ (version ${version})`);
} else {
  await compile(BINARY);
  console.log(`Built ./${BINARY} (version ${version})`);
}
