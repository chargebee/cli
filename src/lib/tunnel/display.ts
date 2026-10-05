import { diagnostic, isJsonMode, streamRecord } from "../output.js";
/** Terminal output for the webhook tunnel. Stripe-style: one ready line, then event rows. */

/** C0 and C1 control characters (including DEL), stripped before an event type is printed. */
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/g;
const MAX_EVENT_TYPE_LEN = 64;
const PROGRESS_FRAMES = [".  ", ".. ", "..."] as const;
const PROGRESS_INTERVAL_MS = 400;

let progressTimer: ReturnType<typeof setInterval> | undefined;
let progressActive = false;
let progressInteractive = false;
let progressFrame = 0;
let progressMessage = "";

function writeDiagnostic(message: string): void {
  process.stderr.write(`> ${message}\n`);
}

function renderProgress(overwrite: boolean): void {
  const line = `> ${progressMessage}${PROGRESS_FRAMES[progressFrame]}`;
  // After a previous diagnostic that ended in `\n`, the first paint must not
  // use `\r` — that would rewrite the line above. Later frames stay on this one.
  process.stderr.write(overwrite ? `\r${line}` : line);
  progressFrame = (progressFrame + 1) % PROGRESS_FRAMES.length;
}

/** Show that connection setup is in progress without polluting stdout event output. */
export function startProgress(message = "Initiating webhook tunnel"): void {
  if (progressActive) return;

  progressActive = true;
  if (streamRecord("connecting", { message })) return;
  progressMessage = message;
  progressFrame = 0;
  progressInteractive = Boolean(process.stderr.isTTY);
  if (!progressInteractive) {
    writeDiagnostic(`${message}...`);
    return;
  }

  renderProgress(false);
  progressTimer = setInterval(() => renderProgress(true), PROGRESS_INTERVAL_MS);
  progressTimer.unref?.();
}

/** Clear a TTY progress line. Safe to call repeatedly and before any diagnostic output. */
export function stopProgress(): void {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = undefined;
  if (progressInteractive) process.stderr.write("\r\x1B[2K");
  progressActive = false;
  progressInteractive = false;
  progressMessage = "";
}

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Make an untrusted `event_type` (it comes from the relay, not validated input)
 * safe to print: strip control characters (so it can't rewrite the terminal
 * line or inject escape sequences) and cap its length.
 */
export function sanitizeEventType(eventType: string): string {
  const stripped = eventType.replace(CONTROL_CHARS_RE, "");
  return stripped.length > MAX_EVENT_TYPE_LEN ? stripped.slice(0, MAX_EVENT_TYPE_LEN) : stripped;
}

export function ready(forwardTo: string): void {
  stopProgress();
  if (streamRecord("ready", { forward_to: forwardTo })) return;
  console.log(`> Ready! Forwarding events to ${forwardTo} (^C to quit)`);
}

/**
 * One line per event that reached the local server: the HTTP status it replied
 * with, marked when it is not a 2xx so a failing handler stands out from successes.
 */
export function event(eventType: string, status: number): void {
  stopProgress();
  if (streamRecord("forward_result", { event_type: sanitizeEventType(eventType), http_status: status })) return;
  const marker = status >= 200 && status < 300 ? "" : " (non-2xx)";
  console.log(`${timestamp()}   ${sanitizeEventType(eventType)} → ${status}${marker}`);
}

/** One line per event whose forward never reached the local server. */
export function eventFailed(eventType: string, reason: string): void {
  stopProgress();
  if (streamRecord("forward_failed", { event_type: sanitizeEventType(eventType), message: reason })) return;
  console.log(`${timestamp()}   ${sanitizeEventType(eventType)} → failed: ${reason}`);
}

export function warn(msg: string): void {
  stopProgress();
  if (streamRecord("warning", { message: msg }, true)) return;
  writeDiagnostic(msg);
}

export function error(msg: string): void {
  stopProgress();
  if (isJsonMode()) { diagnostic(msg); return; }
  writeDiagnostic(msg);
}
