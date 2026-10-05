import { describe, expect, it } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

describe("bundled third-party license notices", () => {
  it("ships a non-empty EULA for @chargebee/code-sample-generator, listed in package.json files", () => {
    const licensePath = resolve("licenses/code-sample-generator.txt");
    expect(statSync(licensePath).size).toBeGreaterThan(0);

    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf-8")) as {
      files: string[];
    };
    expect(pkg.files).toContain("licenses");
  });
});
