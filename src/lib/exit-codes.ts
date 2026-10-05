/**
 * Shared CLI exit-code categories. Some built-in commands use ERROR for failures
 * classified more specifically by the API handler. Commander usage errors use
 * `1`; `2` is unassigned.
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
