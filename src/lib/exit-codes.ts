/**
 * Process exit codes for the CLI. Every command that fails exits with one of
 * these; Commander's own usage errors (unknown command or flag) exit with its
 * default, `1`. `2` is unassigned. Documented in README under "Exit codes" —
 * keep both in sync.
 */
export const EXIT_CODES = {
  OK: 0,
  ERROR: 1,
  UNCONFIGURED: 3,
  INVALID_CREDENTIALS: 4,
  NOT_FOUND: 5,
  REFUSED: 6,
  NETWORK: 7,
} as const;
