/**
 * Parse `bun test --coverage` text output, enforce a per-file 95% floor, and
 * render the sticky PR comment.
 *
 * Bun's bunfig `coverageThreshold` is not used: Bun 1.4.x exits 1 after a
 * green suite even when every file is above 95% (oven-sh/bun#17028).
 *
 * Usage: bun run src/tools/coverage-gate.ts coverage.txt [--comment out.md]
 */
import { readFileSync, writeFileSync } from "node:fs";

export const COVERAGE_THRESHOLD = 95;

export type FileCoverage = {
  file: string;
  functions: number;
  lines: number;
  /** Bun's "Uncovered Line #s" column, verbatim (e.g. `78,82-84`). */
  uncovered: string;
};

export type CoverageReport = {
  all: FileCoverage;
  files: FileCoverage[];
};

const ROW = /^\s*(.+?)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|(.*)$/;

export function parseBunCoverage(text: string): CoverageReport {
  const files: FileCoverage[] = [];
  let all: FileCoverage | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.includes("% Funcs") || line.includes("% Lines")) continue;
    if (/^[\s-|]+$/.test(line)) continue;
    const m = line.match(ROW);
    if (!m) continue;
    const file = m[1].trim();
    if (file === "File") continue;
    const rec: FileCoverage = {
      file,
      functions: Number(m[2]),
      lines: Number(m[3]),
      uncovered: m[4].trim(),
    };
    if (file === "All files") all = rec;
    else files.push(rec);
  }
  if (!all) throw new Error("coverage table missing All files row");
  return { all, files };
}

export function belowThreshold(
  files: FileCoverage[],
  threshold = COVERAGE_THRESHOLD,
): FileCoverage[] {
  return files.filter((f) => f.functions < threshold || f.lines < threshold);
}

export function perFileOk(files: FileCoverage[], threshold = COVERAGE_THRESHOLD): boolean {
  return belowThreshold(files, threshold).length === 0;
}

export const COVERAGE_COMMENT_MARKER = "<!-- cb-cli-coverage -->";

const PASS = "✅";
const FAIL = "❌";

function metricRow(label: string, value: number, threshold: number): string {
  const icon = value >= threshold ? PASS : FAIL;
  return `| ${icon} | ${label} | ${value.toFixed(2)}% | ${threshold}% |`;
}

function weakFileRow(f: FileCoverage): string {
  return `| ${FAIL} | \`${f.file}\` | ${f.functions.toFixed(2)}% | ${f.lines.toFixed(2)}% | ${f.uncovered || "—"} |`;
}

function headline(total: number, weak: number, threshold: number): string {
  if (weak === 0) {
    const subject = total === 1 ? "the only file is" : `all ${total} files are`;
    return `${PASS} **Gate passed** — ${subject} at or above the ${threshold}% floor.`;
  }
  const subject = weak === 1 ? "1 file is" : `${weak} files are`;
  return `${FAIL} **Gate failed** — ${subject} below the ${threshold}% floor.`;
}

export function renderCoverageComment(
  report: CoverageReport,
  threshold = COVERAGE_THRESHOLD,
): string {
  const weak = belowThreshold(report.files, threshold);
  const lines = [
    COVERAGE_COMMENT_MARKER,
    "## Test coverage",
    "",
    headline(report.files.length, weak.length, threshold),
    "",
    "| Status | Metric | Coverage | Threshold |",
    "| :---: | --- | ---: | ---: |",
    metricRow("Functions", report.all.functions, threshold),
    metricRow("Lines", report.all.lines, threshold),
    "",
  ];
  if (weak.length > 0) {
    lines.push(
      "### Files below the floor",
      "",
      "| Status | File | Functions | Lines | Uncovered lines |",
      "| :---: | --- | ---: | ---: | --- |",
      ...weak.map(weakFileRow),
      "",
    );
  }
  return lines.join("\n");
}

export function renderCoverageReport(
  text: string,
  threshold = COVERAGE_THRESHOLD,
): { ok: boolean; comment: string; report: CoverageReport } {
  const report = parseBunCoverage(text);
  const comment = renderCoverageComment(report, threshold);
  return { ok: perFileOk(report.files, threshold), comment, report };
}

export function parseArgs(argv: string[]): { input: string; commentPath?: string } {
  const rest = argv.slice(2);
  let commentPath: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--comment") {
      commentPath = rest[++i];
      continue;
    }
    positional.push(rest[i]);
  }
  const input = positional[0] ?? "-";
  return { input, commentPath };
}

/** Read a coverage table, print the comment, optionally write `--comment`. Returns whether every file met the floor. */
export function runCoverageGate(argv: string[] = process.argv): boolean {
  const { input, commentPath } = parseArgs(argv);
  const text = input === "-" ? readFileSync(0, "utf8") : readFileSync(input, "utf8");
  const { ok, comment, report } = renderCoverageReport(text);
  process.stdout.write(comment);
  if (commentPath) writeFileSync(commentPath, comment);
  if (!ok) {
    const weak = belowThreshold(report.files);
    console.error(
      `coverage gate failed: ${weak.length} file(s) under ${COVERAGE_THRESHOLD}% functions or lines`,
    );
  }
  return ok;
}

if (import.meta.main) {
  process.exit(runCoverageGate(process.argv) ? 0 : 1);
}
