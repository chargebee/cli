import { randomUUID } from "node:crypto";
import { readState, writeState } from "./state.js";

/**
 * Return the persisted anonymous id, generating and saving one on first use.
 * This is the CLI's own identity (Option B) — a random UUID, not derived from
 * any account, machine, or PII.
 */
export function getVisitorId(): string {
  const state = readState();
  if (state.anonymous_id) return state.anonymous_id;
  const id = randomUUID();
  writeState({ anonymous_id: id });
  return id;
}
