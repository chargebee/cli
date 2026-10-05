import { expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { spawnCli } from "../../lib/test-support/_spawn.js";
import { liveEnabled, liveConfig, successful, fixtureEnv } from "../../lib/test-support/live.js";

it.skipIf(!liveEnabled)("documentation discovery resolves resources and operations and rejects unknown names", async () => {
  const dir = liveConfig();
  try {
    for (const args of [["docs"], ["docs", "customer"], ["docs", "customer", "create"]]) {
      const result = await spawnCli(args, { configDir: dir });
      successful(result, args.join(" "));
      expect(result.stdout.toLowerCase()).toContain("customer");
    }
    for (const args of [["docs", "cb-nonexistent-resource"], ["docs", "customer", "cb-nonexistent-operation"]]) {
      const result = await spawnCli(args, { configDir: dir });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Unknown");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 180_000);

for (const language of ["curl", "python", "nodejs", "go", "ruby", "java", "php", "dotnet"]) {
  it.skipIf(!liveEnabled)(`generates ${language} customer code without exposing credentials or executing a write`, async () => {
    const extraEnv = fixtureEnv(1);
    const result = await spawnCli(["customer", "create", "--code-sample", language, "--pc-version", "v2", "-d", "first_name=CLI"], { extraEnv });
    successful(result, `${language} code generation`);
    expect(result.stdout.length).toBeGreaterThan(40);
    expect(result.stdout.toLowerCase()).toContain("customer");
    expect(result.stdout.includes(extraEnv.CHARGEBEE_API_KEY)).toBe(false);
    if (language === "nodejs") {
      // Generated examples use ES imports and top-level await; only parse them.
      const checked = Bun.spawnSync(["node", "--check", "--input-type=module"], { stdin: Buffer.from(result.stdout), stdout: "pipe", stderr: "pipe" });
      expect(checked.exitCode).toBe(0);
    }
  }, 60_000);
}
