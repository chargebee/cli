/**
 * Spawn the real CLI process (not in-process `runCli`).
 *
 * Default: `bun src/index.ts` from the package root (what contributors run).
 * Set `CHARGEBEE_CLI_BINARY` to a compiled `bun build --compile` artifact so
 * CI and live tests hit that file. CHARGEBEE_CLI_NODE selects the Node
 * executable when testing the npm bundle instead of a native binary.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface SpawnCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SpawnCliOptions {
  extraEnv?: Record<string, string>;
  /** Isolated config dir. Empty string / omitted avoids `~/.chargebee/cli`. */
  configDir?: string;
  input?: string;
  timeoutMs?: number;
}

/** Repo / package root, where `src/index.ts` and compiled binaries live. */
export function cliRoot(): string {
  return join(import.meta.dir, "../../..");
}

/** Persist telemetry disable so a subprocess does not print the first-run notice. */
export function writeDisabledTelemetry(dir: string): void {
  writeFileSync(
    join(dir, "telemetry.json"),
    JSON.stringify({ enabled: false, notice_shown: true, anonymous_id: "" }),
  );
}

export function spawnEnv(opts: SpawnCliOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Do not inherit a developer site/key into process tests.
  env.CHARGEBEE_SITE = "";
  env.CHARGEBEE_API_KEY = "";
  env.CHARGEBEE_HOST = "";
  env.CHARGEBEE_REGION = "us";
  env.CHARGEBEE_CLI_KEYCHAIN = "0";
  env.CHARGEBEE_CONFIG_DIR = opts.configDir ?? "";
  Object.assign(env, opts.extraEnv);
  return env;
}

export function spawnArgv(args: string[], cwd: string): string[] {
  const bin = process.env.CHARGEBEE_CLI_BINARY?.trim();
  if (bin) {
    const resolved = isAbsolute(bin) ? bin : join(cwd, bin);
    const node = process.env.CHARGEBEE_CLI_NODE;
    return node ? [node, resolved, ...args] : [resolved, ...args];
  }
  if (process.env.CB_REQUIRE_BINARY === "1") throw new Error("CHARGEBEE_CLI_BINARY is required for artifact tests");
  return ["bun", "src/index.ts", ...args];
}

export async function spawnCli(
  args: string[],
  opts: SpawnCliOptions = {},
): Promise<SpawnCliResult> {
  const cwd = cliRoot();
  const temporary = opts.configDir ? undefined : mkdtempSync(join(tmpdir(), "cb-process-"));
  const configDir = opts.configDir || temporary!;
  if (temporary) writeDisabledTelemetry(temporary);
  try {
    const proc = Bun.spawn({
      cmd: spawnArgv(args, cwd),
      cwd,
      env: spawnEnv({ ...opts, configDir }),
      stdin: opts.input === undefined ? "ignore" : new Blob([opts.input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, opts.timeoutMs ?? 30_000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (timedOut) throw new Error(`CLI timed out after ${opts.timeoutMs ?? 30_000}ms`);
      return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 1 };
    } finally { clearTimeout(timer); }
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
