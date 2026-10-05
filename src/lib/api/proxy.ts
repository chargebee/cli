import { diagnostic, isJsonMode } from "../output.js";
/**
 * Node's global `fetch` (undici) ignores `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`
 * unless the process opts in, on Node 24+, via `NODE_USE_ENV_PROXY=1` or the
 * `--use-env-proxy` CLI flag. Neither exists on Node 22 (the oldest line the npm
 * bundle supports via `engines`): the env var is ignored there, while the flag in
 * `NODE_OPTIONS` makes those versions refuse to start, so the hint recommends
 * the env var. The Bun-compiled binary's `fetch` honours the proxy variables
 * natively.
 *
 * There is no bundled HTTP client here to install a proxy-aware dispatcher for
 * (undici is not a dependency of this package, direct or transitive), so under
 * Node with a proxy variable set and no opt-in active, print a one-time stderr
 * hint pointing at the two ways around it instead of silently making requests
 * that bypass the configured proxy.
 */

const PROXY_ENV_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

let hintShown = false;

/** TEST-ONLY: allow the one-time hint to be shown again. */
export function __resetProxyHint(): void {
  hintShown = false;
}

function isNodeRuntime(): boolean {
  return process.versions.bun === undefined;
}

/** True when a Node 24+ env-proxy opt-in is active for this process (Node only honours the exact value "1"). */
function envProxyFlagActive(): boolean {
  if (process.env.NODE_USE_ENV_PROXY === "1") return true;
  const nodeOptions = process.env.NODE_OPTIONS ?? "";
  return process.execArgv.some((a) => a.includes("--use-env-proxy")) || nodeOptions.includes("--use-env-proxy");
}

/**
 * Print a one-time stderr hint when running under Node with a proxy env var
 * set but no way to honour it. No-op under Bun, when no proxy var is set, or
 * when an env-proxy opt-in is already active.
 */
export function maybeWarnUnproxiedNode(): void {
  if (hintShown || !isNodeRuntime()) return;
  const proxyVar = PROXY_ENV_VARS.find((k) => process.env[k]);
  if (!proxyVar) return;
  if (envProxyFlagActive()) return;

  hintShown = true;
  const write = isJsonMode() ? diagnostic : process.stderr.write.bind(process.stderr);
  write(
    `${proxyVar} is set but the npm build of the CLI does not route through proxies yet; ` +
      "use the standalone binary or, on Node 24+, set NODE_USE_ENV_PROXY=1.\n",
  );
}
