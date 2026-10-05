import { buildProgram } from "../../program.js";
import { __setClientFactory, __resetRuntimeState } from "../api/sdk.js";

/** Thrown in place of `process.exit()` so we can capture the exit code. */
class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** A site's catalog, as detectCatalog would report it. */
export interface FakeCatalog {
  /** "v1" | "v2" */
  pcv: string;
  /** "plans_addons" | "items" | "compat" */
  schema: string;
}

/** A single fake SDK client construction (the resolved credentials). */
export interface ClientConstruction {
  site: string;
  apiKey: string;
  hostSuffix: string;
}

export interface FakeClientOptions {
  /** Records every client construction so tests can assert the resolved site/key. */
  constructions: ClientConstruction[];
  /** Per-site catalog. Defaults to a PC2 ("items") site when a site isn't listed. */
  catalogBySite?: Record<string, FakeCatalog>;
  /** Records the raw `id` argument every `customer.retrieve` call receives. */
  customerRetrieveCalls?: string[];
}

/** Mimic the Chargebee Node SDK attaching HTTP transport onto the JSON body. */
function sdkResult<T extends Record<string, unknown>>(body: T) {
  return {
    ...body,
    headers: {
      "content-type": "application/json;charset=utf-8",
      server: "ChargeBee",
    },
    httpStatusCode: 200,
    isIdempotencyReplayed: false,
  };
}

/**
 * Install a fake SDK client factory. The fake records the resolved site/apiKey
 * and returns canned responses whose ids embed the site, so output assertions
 * can confirm which site a command actually hit.
 */
export function installFakeClient(opts: FakeClientOptions): void {
  __setClientFactory((init: { site: string; apiKey: string; hostSuffix: string; protocol?: string }) => {
    opts.constructions.push({ site: init.site, apiKey: init.apiKey, hostSuffix: init.hostSuffix });
    const cat = opts.catalogBySite?.[init.site] ?? { pcv: "v2", schema: "items" };
    const site = init.site;
    const fake = {
      configuration: {
        list: async () => ({
          configurations: [
            { product_catalog_version: cat.pcv, chargebee_response_schema_type: cat.schema },
          ],
        }),
      },
      customer: {
        list: async () => sdkResult({ list: [{ customer: { id: `cus_${site}` } }] }),
        create: async () => sdkResult({ customer: { id: `cus_new_${site}` } }),
        retrieve: async (id: string) => {
          opts.customerRetrieveCalls?.push(id);
          return sdkResult({ customer: { id: `cus_${site}` } });
        },
      },
      item: {
        list: async () => sdkResult({ list: [{ item: { id: `item_${site}` } }] }),
      },
      estimate: {
        createSubItemEstimate: async () => sdkResult({ estimate: { id: `est_${site}` } }),
      },
      export: {
        customers: async () => sdkResult({ export: { id: `exp_${site}` } }),
      },
      plan: {
        list: async () => sdkResult({ list: [{ plan: { id: `plan_${site}` } }] }),
      },
    };
    return fake as never;
  });
}

/** Restore the real SDK client factory. */
export function uninstallFakeClient(): void {
  __setClientFactory(null);
}

/**
 * Snapshot/restore process.env for one test file. First `set` of a key wins
 * as the restore value, matching the previous per-file setEnv helpers.
 */
export function createEnvPatcher(): {
  set(key: string, value: string | undefined): void;
  restore(): void;
} {
  const saved: Record<string, string | undefined> = {};
  return {
    set(key, value) {
      if (!(key in saved)) saved[key] = process.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    },
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
        delete saved[k];
      }
    },
  };
}

/**
 * Run the CLI in-process with the given args. Captures stdout/stderr (both
 * `console.*` and direct `process.std*.write`) and the exit code, restoring all
 * globals afterwards.
 */
export async function runCli(args: string[]): Promise<RunResult> {
  __resetRuntimeState();

  let stdout = "";
  let stderr = "";

  const origLog = console.log;
  const origError = console.error;
  const origOutWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  const origExitCode = process.exitCode;
  process.exitCode = 0;

  const toStr = (c: unknown): string =>
    typeof c === "string" ? c : Buffer.isBuffer(c) ? c.toString("utf8") : String(c);

  console.log = (...a: unknown[]) => {
    stdout += a.map(toStr).join(" ") + "\n";
  };
  console.error = (...a: unknown[]) => {
    stderr += a.map(toStr).join(" ") + "\n";
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (c: unknown) => {
    stdout += toStr(c);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (c: unknown) => {
    stderr += toStr(c);
    return true;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (code?: number) => {
    throw new ExitError(code ?? 0);
  };

  let exitCode = 0;
  try {
    const program = buildProgram("0.0.0-test");
    await program.parseAsync(args, { from: "user" });
    exitCode = Number(process.exitCode ?? 0);
  } catch (err) {
    if (err instanceof ExitError) {
      exitCode = err.code;
    } else if (err && typeof err === "object" && "exitCode" in err) {
      // Commander error (unknown command/option, help, version, command.error).
      exitCode = (err as { exitCode?: number }).exitCode ?? 1;
    } else {
      exitCode = 1;
      stderr += (err instanceof Error ? err.message : String(err)) + "\n";
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = origOutWrite;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = origErrWrite;
    process.exit = origExit;
    process.exitCode = origExitCode;
  }

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

/**
 * Pin `process.stdin.isTTY` for a test. Restore with the returned function.
 * Isolated CLI tests that must not open Clack should pin `false`; interactive
 * prompt tests pin `true` and restore so a developer TTY cannot leak into
 * later files (that hang on `confirm()` until the 5s timeout).
 */
export function setStdinIsTTY(value: boolean): () => void {
  return setIsTTY(process.stdin, value);
}

/** Pin `process.stdout.isTTY` for a test. Restore with the returned function. */
export function setStdoutIsTTY(value: boolean): () => void {
  return setIsTTY(process.stdout, value);
}

/** Pin `process.stderr.isTTY` for a test. Restore with the returned function. */
export function setStderrIsTTY(value: boolean): () => void {
  return setIsTTY(process.stderr, value);
}

function setIsTTY(stream: NodeJS.WriteStream | NodeJS.ReadStream, value: boolean): () => void {
  const orig = Object.getOwnPropertyDescriptor(stream, "isTTY");
  Object.defineProperty(stream, "isTTY", {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
  return () => {
    if (orig) Object.defineProperty(stream, "isTTY", orig);
    else delete (stream as { isTTY?: boolean }).isTTY;
  };
}

/** Env vars the telemetry recorder's CI detection reads. */
const CI_ENV_KEYS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "JENKINS_URL",
  "BUILDKITE",
  "TRAVIS",
  "TEAMCITY_VERSION",
  "TF_BUILD",
];

/**
 * Clear every CI-detection env var for one test, so telemetry under test is
 * not disabled by the CI runner the suite itself is running on. Restore with
 * the returned function.
 */
export function clearCiEnv(): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const k of CI_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}
