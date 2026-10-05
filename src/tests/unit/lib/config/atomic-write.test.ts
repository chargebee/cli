import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../../../lib/config/atomic-write.js";

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file at mode 0600 with no separate chmod step", async () => {
    const p = join(dir, "secret.json");
    await writeFileAtomic(p, "hello");
    expect(readFileSync(p, "utf-8")).toBe("hello");
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it("leaves no temp file behind in the target directory", async () => {
    const p = join(dir, "secret.json");
    await writeFileAtomic(p, "hello");
    const leftovers = readdirSync(dir).filter((f) => f !== "secret.json");
    expect(leftovers).toEqual([]);
  });

  it("overwrites an existing file atomically, still at mode 0600", async () => {
    const p = join(dir, "secret.json");
    await writeFileAtomic(p, "one");
    await writeFileAtomic(p, "two");
    expect(readFileSync(p, "utf-8")).toBe("two");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["secret.json"]);
  });
});
