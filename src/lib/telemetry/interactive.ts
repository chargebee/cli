/**
 * Shared, dependency-free flag marking whether the current invocation displayed an
 * interactive prompt (e.g. an `@clack/prompts` text/select waiting on the user).
 *
 * Lives in its own module (importing nothing) so the prompt wrapper (`lib/prompts.ts`)
 * can set it without importing the recorder (`telemetry/index.ts`, which imports
 * `sdk.ts`) — avoiding an import cycle. The recorder reads it at finalize time to omit
 * `dur_ms` for interactive runs, where the elapsed time is dominated by human
 * input rather than actual CLI work and would otherwise pollute latency analysis.
 */
let _interactive = false;

/** Mark that an interactive prompt was shown during this invocation. */
export function markInteractive(): void {
  _interactive = true;
}

/** Whether an interactive prompt was shown during this invocation. */
export function wasInteractive(): boolean {
  return _interactive;
}

/** TEST-ONLY: clear the latch between tests. */
export function __resetInteractiveForTest(): void {
  _interactive = false;
}
