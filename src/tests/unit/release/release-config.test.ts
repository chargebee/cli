import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../../..");
const config = JSON.parse(readFileSync(join(root, "release-please-config.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, ".release-please-manifest.json"), "utf8"));
const pkg = config.packages["."];

describe("release configuration", () => {
  test("main releases stable versions", () => {
    expect(pkg.versioning).toBe("default");
    expect(pkg.prerelease).toBe(false);
  });

  test("release bookkeeping matches the package version", () => {
    const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(manifest["."]).toBe(metadata.version);
    expect(metadata.publishConfig.access).toBe("public");
  });
});
