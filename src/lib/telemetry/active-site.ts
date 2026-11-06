/**
 * Shared, dependency-free slot for a site the current invocation made active
 * (`auth add`, `auth switch`).
 *
 * Lives in its own module (importing nothing) so commands can set it without
 * importing the recorder (`telemetry/index.ts`, which imports `sdk.ts`). The
 * recorder reads the active site before the command runs, so without this the
 * event would carry the previous site (or `unconfigured`). It reads this slot at
 * finalize time and prefers it.
 */
let _site: string | undefined;

/** Record the site this invocation made active. Call only after it is saved. */
export function noteActiveSite(site: string): void {
  _site = site;
}

/** Read and clear the noted site. */
export function takeActiveSite(): string | undefined {
  const v = _site;
  _site = undefined;
  return v;
}
