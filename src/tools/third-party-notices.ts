#!/usr/bin/env bun
/**
 * Generates THIRD_PARTY_NOTICES.txt: one section per third-party package
 * that Bun's bundler actually inlines into dist/index.js.
 *
 * The bundled set comes from `Bun.build`'s metafile for src/index.ts, built
 * with the same target/minify settings as `build:npm`. The metafile lists
 * every module the bundler kept in the output, so a package that is
 * installed but never reaches the bundle (for example a dependency pulled in
 * only by a dead branch of another package) is correctly left out — matching
 * what a string search of the compiled dist/index.js would show.
 *
 * Usage:
 *   bun run src/tools/third-party-notices.ts [--out <path>] [--check]
 *
 * --check exits 1 if the file at --out (default THIRD_PARTY_NOTICES.txt)
 * differs from a freshly generated one, for CI drift detection.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_OUT = resolve(ROOT, "THIRD_PARTY_NOTICES.txt");
const GENERATOR_PACKAGE = "@chargebee/code-sample-generator";
const GENERATOR_LICENSE_PATH = "licenses/code-sample-generator.txt";

interface PackageInfo {
  name: string;
  version: string;
  license: string;
  licenseText: string | null;
}

interface BunBuildMetafile {
  inputs: Record<string, unknown>;
}

/**
 * Walks up from a bundled module's path to the root directory of the
 * `node_modules` package it belongs to (handling scoped `@scope/name`
 * packages). Returns null for project-local files, which live outside any
 * `node_modules` directory.
 */
function packageRootFor(inputPath: string): string | null {
  const marker = `node_modules${sep}`;
  const idx = inputPath.lastIndexOf(marker);
  if (idx === -1) return null;

  const prefix = inputPath.slice(0, idx + marker.length);
  const rest = inputPath.slice(idx + marker.length).split(sep);
  const nameSegments = rest[0]?.startsWith("@") ? rest.slice(0, 2) : rest.slice(0, 1);
  return prefix + nameSegments.join(sep);
}

async function findBundledPackageRoots(): Promise<Set<string>> {
  const result = await Bun.build({
    entrypoints: [join(ROOT, "src/index.ts")],
    target: "node",
    minify: true,
    // `metafile` returns the module graph Bun actually traversed and kept;
    // it is not part of Bun's public TypeScript types yet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...({ metafile: true } as any),
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("bundling src/index.ts failed while collecting the third-party notice graph");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const metafile = (result as any).metafile as BunBuildMetafile | undefined;
  if (!metafile?.inputs) {
    throw new Error("Bun.build did not return a metafile; cannot determine the bundled package set");
  }

  const roots = new Set<string>();
  for (const inputPath of Object.keys(metafile.inputs)) {
    const root = packageRootFor(resolve(ROOT, inputPath));
    if (root) roots.add(root);
  }
  return roots;
}

function normalizeLicense(pkgJson: {
  license?: string | { type?: string };
  licenses?: Array<{ type?: string }>;
}): string {
  if (typeof pkgJson.license === "string") return pkgJson.license;
  if (pkgJson.license?.type) return pkgJson.license.type;
  if (pkgJson.licenses?.length) {
    return pkgJson.licenses
      .map((l) => l.type)
      .filter(Boolean)
      .join(" OR ");
  }
  return "UNKNOWN";
}

function readPackageInfo(pkgRoot: string): PackageInfo {
  const pkgJson = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf-8")) as {
    name: string;
    version: string;
    license?: string | { type?: string };
    licenses?: Array<{ type?: string }>;
  };

  const licenseFileName = readdirSync(pkgRoot)
    .filter((f) => /^(license|licence|copying)(\..*)?$/i.test(f))
    .sort()[0];

  const licenseText = licenseFileName ? readFileSync(join(pkgRoot, licenseFileName), "utf-8").trim() : null;

  return {
    name: pkgJson.name,
    version: pkgJson.version,
    license: normalizeLicense(pkgJson),
    licenseText,
  };
}

function renderSection(pkg: PackageInfo): string {
  const heading = `${pkg.name}@${pkg.version} (${pkg.license})`;
  const divider = "-".repeat(heading.length);

  let body: string;
  if (pkg.name === GENERATOR_PACKAGE) {
    body = `Licensed under Chargebee's generator EULA. The full text is shipped once, at\n${GENERATOR_LICENSE_PATH}, and is not repeated here.`;
  } else if (pkg.licenseText) {
    body = pkg.licenseText;
  } else {
    body = `This package ships no LICENSE, LICENCE, or COPYING file. Its package.json\ndeclares the SPDX license identifier "${pkg.license}".`;
  }

  return `${heading}\n${divider}\n${body}\n`;
}

async function generateNotices(): Promise<string> {
  const roots = await findBundledPackageRoots();
  const packages = [...roots].map(readPackageInfo).sort((a, b) => a.name.localeCompare(b.name));

  const header = [
    "THIRD_PARTY_NOTICES.txt",
    "========================",
    "",
    "The Chargebee CLI's compiled binaries and npm distribution embed every",
    "package listed below (resolved from the module graph Bun's bundler keeps",
    "in dist/index.js). This file reproduces each package's license so the",
    "notice travels with the code it applies to. It is generated by",
    "`bun run src/tools/third-party-notices.ts`; do not edit it by hand.",
  ].join("\n");

  const sections = packages.map(renderSection).join("\n");
  return `${header}\n\n${sections}`.trimEnd() + "\n";
}

export async function runNoticesCli(
  argv: string[] = process.argv.slice(2),
  generate: () => Promise<string> = generateNotices,
): Promise<void> {
  let outPath = DEFAULT_OUT;
  let checkOnly = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--check") {
      checkOnly = true;
    } else if (argv[i] === "--out") {
      const value = argv[++i];
      if (!value) throw new Error("--out requires a path argument");
      outPath = resolve(value);
    }
  }

  const content = await generate();

  if (checkOnly) {
    if (!existsSync(outPath) || readFileSync(outPath, "utf-8") !== content) {
      console.error(
        `${outPath} is missing or out of date. Regenerate it with \`bun run src/tools/third-party-notices.ts\`.`,
      );
      process.exit(1);
    }
    console.log(`${outPath} is up to date.`);
    return;
  }

  writeFileSync(outPath, content);
  console.log(`Wrote ${outPath}`);
}

if (import.meta.main) {
  void runNoticesCli();
}

export { generateNotices };
