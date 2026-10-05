import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COVERAGE_COMMENT_MARKER,
  COVERAGE_THRESHOLD,
  belowThreshold,
  parseArgs,
  parseBunCoverage,
  perFileOk,
  renderCoverageReport,
  runCoverageGate,
} from "../../../tools/coverage-gate.js";

const SAMPLE = `
----------------------------------------------------|---------|---------|-------------------
File                                                | % Funcs | % Lines | Uncovered Line #s
----------------------------------------------------|---------|---------|-------------------
All files                                           |   96.44 |   96.57 |
 src/commands/skills.ts                             |  100.00 |   76.77 | 42-43
 src/lib/ui/color.ts                                |  100.00 |  100.00 |
 src/tools/third-party-notices.ts                   |   91.67 |   70.34 | 67-68
----------------------------------------------------|---------|---------|-------------------
`;

const PASSING = `
----------------------------------------------------|---------|---------|-------------------
File                                                | % Funcs | % Lines | Uncovered Line #s
----------------------------------------------------|---------|---------|-------------------
All files                                           |   99.92 |   99.49 |
 src/commands/open.ts                               |  100.00 |   95.83 | 44,46
 src/lib/ui/color.ts                                |  100.00 |  100.00 |
----------------------------------------------------|---------|---------|-------------------
`;

describe("parseBunCoverage", () => {
  it("reads the All files aggregate, per-file rows, and uncovered lines", () => {
    const report = parseBunCoverage(SAMPLE);
    expect(report.all).toEqual({
      file: "All files",
      functions: 96.44,
      lines: 96.57,
      uncovered: "",
    });
    expect(report.files).toEqual([
      { file: "src/commands/skills.ts", functions: 100, lines: 76.77, uncovered: "42-43" },
      { file: "src/lib/ui/color.ts", functions: 100, lines: 100, uncovered: "" },
      {
        file: "src/tools/third-party-notices.ts",
        functions: 91.67,
        lines: 70.34,
        uncovered: "67-68",
      },
    ]);
  });

  it("throws when the aggregate row is missing", () => {
    expect(() => parseBunCoverage("no table here")).toThrow(/All files/);
  });
});

describe("perFileOk", () => {
  it("passes when every file is at the 95% floor", () => {
    expect(perFileOk(parseBunCoverage(PASSING).files)).toBe(true);
  });

  it("fails when any file is under the floor", () => {
    expect(perFileOk(parseBunCoverage(SAMPLE).files)).toBe(false);
  });
});

describe("renderCoverageReport", () => {
  it("names the failing files and their uncovered lines when the gate fails", () => {
    const { ok, comment, report } = renderCoverageReport(SAMPLE);
    expect(ok).toBe(false);
    expect(report.all.functions).toBeGreaterThanOrEqual(COVERAGE_THRESHOLD);
    expect(belowThreshold(report.files).map((f) => f.file)).toEqual([
      "src/commands/skills.ts",
      "src/tools/third-party-notices.ts",
    ]);
    expect(comment).toContain(COVERAGE_COMMENT_MARKER);
    expect(comment).toContain("❌ **Gate failed** — 2 files are below the 95% floor.");
    expect(comment).toContain("| ✅ | Functions | 96.44% | 95% |");
    expect(comment).toContain("| ✅ | Lines | 96.57% | 95% |");
    expect(comment).toContain("### Files below the floor");
    expect(comment).toContain("| ❌ | `src/commands/skills.ts` | 100.00% | 76.77% | 42-43 |");
    expect(comment).not.toContain("src/lib/ui/color.ts");
  });

  it("flags the metric row that is itself under the floor", () => {
    const { comment } = renderCoverageReport(SAMPLE.replace("96.44 |   96.57", "94.00 |   96.57"));
    expect(comment).toContain("| ❌ | Functions | 94.00% | 95% |");
    expect(comment).toContain("| ✅ | Lines | 96.57% | 95% |");
  });

  it("renders only the headline and metric table when every file passes", () => {
    const { ok, comment } = renderCoverageReport(PASSING);
    expect(ok).toBe(true);
    expect(comment).toContain("✅ **Gate passed** — all 2 files are at or above the 95% floor.");
    expect(comment).toContain("| ✅ | Functions | 99.92% | 95% |");
    expect(comment).not.toContain("Files below the floor");
    expect(comment).not.toContain("<details>");
    expect(comment).not.toContain("src/commands/open.ts");
  });

  it("renders a dash when a failing file has no uncovered lines", () => {
    const noUncovered = `
All files                                           |   94.00 |  100.00 |
 src/lib/thin.ts                                    |   50.00 |  100.00 |
`;
    expect(renderCoverageReport(noUncovered).comment).toContain(
      "| ❌ | `src/lib/thin.ts` | 50.00% | 100.00% | — |",
    );
  });

  it("uses singular wording for a single failing file", () => {
    const single = `
All files                                           |   94.00 |  100.00 |
 src/lib/thin.ts                                    |   50.00 |  100.00 | 7
`;
    expect(renderCoverageReport(single).comment).toContain(
      "❌ **Gate failed** — 1 file is below the 95% floor.",
    );
  });

  it("uses singular wording for a lone passing file", () => {
    const single = `
All files                                           |  100.00 |  100.00 |
 src/lib/thin.ts                                    |  100.00 |  100.00 |
`;
    expect(renderCoverageReport(single).comment).toContain(
      "✅ **Gate passed** — the only file is at or above the 95% floor.",
    );
  });
});

describe("parseArgs", () => {
  it("defaults the input to stdin and captures --comment", () => {
    expect(parseArgs(["bun", "coverage-gate.ts"])).toEqual({ input: "-" });
    expect(parseArgs(["bun", "coverage-gate.ts", "cov.txt", "--comment", "out.md"])).toEqual({
      input: "cov.txt",
      commentPath: "out.md",
    });
  });
});

describe("runCoverageGate", () => {
  let dir: string | undefined;
  let stdoutSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    stdoutSpy?.mockRestore();
    errorSpy?.mockRestore();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("prints the comment, writes --comment, and returns true when every file is at 95%", () => {
    dir = mkdtempSync(join(tmpdir(), "cb-cov-gate-"));
    const input = join(dir, "coverage.txt");
    const commentPath = join(dir, "comment.md");
    writeFileSync(input, PASSING);
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    errorSpy = spyOn(console, "error").mockImplementation(() => {});

    expect(runCoverageGate(["bun", "coverage-gate.ts", input, "--comment", commentPath])).toBe(true);
    expect(readFileSync(commentPath, "utf-8")).toContain(COVERAGE_COMMENT_MARKER);
    expect(readFileSync(commentPath, "utf-8")).toContain("**Gate passed**");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("returns false and prints the miss when a file is under 95%", () => {
    dir = mkdtempSync(join(tmpdir(), "cb-cov-gate-fail-"));
    const input = join(dir, "coverage.txt");
    writeFileSync(input, SAMPLE);
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation((() => true) as never);
    errorSpy = spyOn(console, "error").mockImplementation(() => {});

    expect(runCoverageGate(["bun", "coverage-gate.ts", input])).toBe(false);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("coverage gate failed");
  });
});
