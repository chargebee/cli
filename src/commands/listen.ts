import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { Command } from "commander";

import {
  detectCatalog,
  isLiveSite,
  resolveApiHost,
  resolveAuth,
  resolveCatalogVersion,
  resolveRegion,
  resolveSchemaType,
} from "../lib/api/sdk.js";
import { exitCommand, finishOutput, streamRecord, diagnostic, exitAfterOutput, isJsonMode } from "../lib/output.js";
import type { Region } from "../lib/config/region.js";
import { appsyncEndpoints, appsyncUnavailableMessage } from "../lib/config/urls.js";
import { isDualModeSite } from "../lib/tunnel/dual-mode.js";
import { AppSyncErrorCode, listenUserMessage } from "../lib/tunnel/appsync-errors.js";
import * as display from "../lib/tunnel/display.js";
import { resolveForwardTarget } from "../lib/tunnel/forwarder.js";
import {
  classifyNonSdkError,
  recordTelemetryError,
} from "../lib/telemetry/error.js";
import { setCommandGroup } from "./help.js";

const DEFAULT_SHUTDOWN_DEADLINE_MS = 3000;
let shutdownDeadlineMs = DEFAULT_SHUTDOWN_DEADLINE_MS;

type ExitFn = (code: number) => void;
function defaultExit(code: number): void {
  if (isJsonMode()) { exitAfterOutput(code); return; }
  exitCommand(code);
}
let exitFn: ExitFn = defaultExit;

/** TEST-ONLY: replace the exit call used by graceful-shutdown signal handling (pass null to restore). */
export function __setExitForTest(fn: ExitFn | null): void {
  exitFn = fn ?? defaultExit;
}

/** TEST-ONLY: shorten the graceful-shutdown deadline (pass null to restore). */
export function __setShutdownDeadlineForTest(ms: number | null): void {
  shutdownDeadlineMs = ms ?? DEFAULT_SHUTDOWN_DEADLINE_MS;
}

/** Call `exitFn`. Real `process.exit` never returns; a test double that returns or throws must not break the signal/timer callback this runs in. */
function forceExit(code: number): void {
  try {
    diagnostic(code === 130 ? "Listener shutdown interrupted." : "Listener shutdown timed out.");
    finishOutput(code, "shutdown_failed");
    exitFn(code);
  } catch {
    // ignore — see above
  }
}

export function registerListenCommand(program: Command): void {
  const listen = program
    .command("listen")
    .description("Forward webhook events on your local machine")
    .requiredOption(
      "-f, --forward-to <endpoint>",
      "Local endpoint to forward webhook events to",
    )
    .action(
      async (opts: { forwardTo: string }) => {
        const target = resolveForwardTarget(opts.forwardTo);
        if ("error" in target) {
          recordTelemetryError("listen_invalid_forward_to");
          display.error(target.error);
          exitCommand(1);
        }
        if (target.warning) {
          display.warn(target.warning);
        }

        let site: string;
        let apiKey: string;
        try {
          ({ site, apiKey } = await resolveAuth());
        } catch (err) {
          recordTelemetryError(classifyNonSdkError(err));
          display.error(err instanceof Error ? err.message : String(err));
          exitCommand(1);
        }

        if (isLiveSite(site, apiKey)) {
          recordTelemetryError("listen_live_blocked");
          display.error(
            `Refusing to listen on live site "${site}".\n\n` +
              `  Webhook tunneling is only available on test sites (name ending in "-test", or a test_ API key).`,
          );
          exitCommand(1);
        }

        const host = await resolveApiHost();

        // Each region has its own tunnel endpoint; pick it from the profile
        // or CHARGEBEE_REGION before connecting.
        let region: Region;
        try {
          region = await resolveRegion();
        } catch (err) {
          recordTelemetryError("listen_invalid_region");
          display.error(err instanceof Error ? err.message : String(err));
          exitCommand(1);
        }

        const endpoints = appsyncEndpoints(host, region);
        if (!endpoints) {
          recordTelemetryError("listen_unavailable");
          display.error(appsyncUnavailableMessage(host, region));
          exitCommand(1);
        }

        // Loaded only when listen runs, so the CLI starts even on a runtime
        // without a WebSocket global. Checked before any API call.
        const { resolveWebSocketCtor, runAppSync, WEBSOCKET_UNAVAILABLE_MESSAGE } =
          await import("../lib/tunnel/appsync.js");
        if (!resolveWebSocketCtor()) {
          recordTelemetryError("cli_error");
          display.error(WEBSOCKET_UNAVAILABLE_MESSAGE);
          exitCommand(1);
        }

        display.startProgress();
        let pcv = await resolveCatalogVersion();
        let schema = await resolveSchemaType();
        if (!pcv || !schema) {
          try {
            const catalog = await detectCatalog(site, apiKey);
            pcv = pcv ?? catalog.productCatalogVersion;
            schema = schema ?? catalog.responseSchemaType;
          } catch (err) {
            recordTelemetryError(classifyNonSdkError(err));
            display.error(err instanceof Error ? err.message : String(err));
            exitCommand(1);
          }
        }

        const sessionId = randomUUID();

        const isDualMode = isDualModeSite(pcv, schema);

        const forwardTo = target.url;

        const ac = new AbortController();

        let shuttingDown = false;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

        // First signal: publish `disable` and close gracefully, but force an exit
        // after shutdownDeadlineMs so an unreachable peer can't hang the process.
        // A second signal during that window means "stop waiting" — exit now.
        const onShutdownSignal = AsyncResource.bind(() => {
          if (shuttingDown) {
            if (deadlineTimer) clearTimeout(deadlineTimer);
            forceExit(130);
            return;
          }
          shuttingDown = true;
          display.stopProgress();
          ac.abort();
          deadlineTimer = setTimeout(() => forceExit(1), shutdownDeadlineMs);
          deadlineTimer.unref?.();
        });

        process.on("SIGINT", onShutdownSignal);
        process.on("SIGTERM", onShutdownSignal);
        // SIGHUP doesn't exist on Windows; only SIGINT is guaranteed there.
        if (process.platform !== "win32") {
          process.on("SIGHUP", onShutdownSignal);
        }

        const outcome = await runAppSync({
          httpDomain: endpoints.httpDomain,
          realtimeDomain: endpoints.realtimeDomain,
          site,
          apiKey,
          forwardTo,
          sessionId,
          responseSchemaType: schema,
          isDualMode,
          signal: ac.signal,
        });

        if (deadlineTimer) clearTimeout(deadlineTimer);
        process.removeListener("SIGINT", onShutdownSignal);
        process.removeListener("SIGTERM", onShutdownSignal);
        if (process.platform !== "win32") {
          process.removeListener("SIGHUP", onShutdownSignal);
        }

        if (outcome.kind === "permanent") {
          recordTelemetryError(
            outcome.code === AppSyncErrorCode.APPSYNC_UNAUTHORIZED
              ? "listen_unauthorized"
              : "listen_tunnel_error",
          );
          const message = listenUserMessage(outcome.code, outcome.detail);
          display.error(message || outcome.reason);
          exitCommand(1, "listen_failed");
        }
        streamRecord("stopped");
      },
    );

  setCommandGroup(listen, "core");
}
