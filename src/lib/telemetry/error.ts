/**
 * Shared, dependency-free slot for the current invocation's error category.
 *
 * Lives in its own module (importing nothing) so shared error paths — the SDK
 * error handler and the safety gates in `sdk.ts` — can annotate telemetry without
 * creating an import cycle with the recorder (`telemetry/index.ts`, which imports
 * `sdk.ts`). The recorder reads it at finalize time.
 */
let _errorType: string | undefined;

const UNCONFIGURED_KIND = "unconfigured";

/** Mark an Error so {@link classifyNonSdkError} reports `unconfigured`. */
export function markUnconfigured(err: Error): Error {
  (err as Error & { telemetryKind?: string }).telemetryKind = UNCONFIGURED_KIND;
  return err;
}

/**
 * Coarse category for a non-SDK failure. `unconfigured` only when the error was
 * marked at the throw site — never inferred from free-form text.
 */
export function classifyNonSdkError(err: unknown): string {
  if (err && typeof err === "object" && "telemetryKind" in err) {
    const kind = (err as { telemetryKind?: unknown }).telemetryKind;
    if (kind === UNCONFIGURED_KIND) return UNCONFIGURED_KIND;
  }
  return "cli_error";
}

/** Record a coarse error category (first one wins). Names only — never values. */
export function recordTelemetryError(errorType: string): void {
  if (!_errorType) _errorType = errorType;
}

/** Read and clear the recorded category. */
export function takeTelemetryError(): string | undefined {
  const v = _errorType;
  _errorType = undefined;
  return v;
}
