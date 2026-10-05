/**
 * The npm bundle runs under plain Node (engines >=22, which ships a global
 * `WebSocket`). Only `chargebee listen` may depend on that global, and only
 * when it actually connects — never at module load — so a runtime without
 * one still starts every other command.
 *
 * Runs in a subprocess so the module registry is fresh (an in-process
 * `import()` would reuse the already-evaluated tunnel module).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { cliRoot } from "../../../../lib/test-support/_spawn.js";

async function runWithoutWebSocket(script: string): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn({
    cmd: ["bun", "-e", `delete globalThis.WebSocket; ${script}`],
    cwd: cliRoot(),
    env: { ...process.env, CHARGEBEE_SITE: "", CHARGEBEE_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

describe("startup without a global WebSocket", () => {
  test("importing and building the program does not throw", async () => {
    const programPath = join(cliRoot(), "src/program.ts");
    const { stdout, stderr, exitCode } = await runWithoutWebSocket(
      `const { buildProgram } = await import(${JSON.stringify(programPath)});` +
        `const p = buildProgram("0.0.0-test");` +
        `console.log("ok", p.commands.some((c) => c.name() === "listen"));`,
    );
    expect(stderr).not.toContain("WebSocket is not defined");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("ok true");
  });

  test("importing the tunnel module itself does not throw", async () => {
    const tunnelPath = join(cliRoot(), "src/lib/tunnel/appsync.ts");
    const { stdout, stderr, exitCode } = await runWithoutWebSocket(
      `const m = await import(${JSON.stringify(tunnelPath)});` +
        `console.log("ctor", m.resolveWebSocketCtor());`,
    );
    expect(stderr).not.toContain("WebSocket is not defined");
    expect(exitCode).toBe(0);
    expect(stdout).toBe("ctor null");
  });
});
