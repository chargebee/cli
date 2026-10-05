/**
 * Build the flat, string-only metadata map for a command event.
 *
 * This is a strict allow-list: only the fields below are ever emitted. No argument
 * values, no API keys, no free-form user input — only flag *names* and coarse
 * environment facts. The command path is the event `name`, not a metadata key.
 * Values are coerced to strings and capped to satisfy the server's metadata limits.
 */
export interface MetadataInput {
  flagNames: string[];
  /** Omitted for interactive commands, where elapsed time is human input, not work. */
  durationMs?: number;
  status: "ok" | "error";
  errorType?: string;
  productCatalogVersion?: string;
  generatedResource?: string;
  listenPhase?: "established" | "closed" | "error";
}

const MAX_VALUE_LEN = 1024;

function clip(v: string): string {
  return v.length > MAX_VALUE_LEN ? v.slice(0, MAX_VALUE_LEN) : v;
}

/**
 * Languages accepted by `--code-sample`. `list` is a meta-action (it prints the
 * supported languages and returns) rather than a generation, so it — and any
 * unrecognized value — is NOT recorded. Node aliases collapse to `js` on the wire.
 */
const CODE_LANG_ALIASES: Record<string, string> = {
  nodejs: "js",
  node: "js",
  javascript: "js",
};

const CODE_LANGS = new Set([
  "curl",
  "python",
  "js",
  "go",
  "ruby",
  "java",
  "php",
  "dotnet",
  "csharp",
]);

/** Normalize a `--code-sample` value into a telemetry language, or undefined. */
export function normalizeGeneratedResource(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lang = value.trim().toLowerCase();
  const wire = CODE_LANG_ALIASES[lang] ?? lang;
  return CODE_LANGS.has(wire) ? wire : undefined;
}

/** Detect a CI environment from the conventional env vars. */
export function detectIsCi(): boolean {
  if (envTruthy("CI")) return true;
  return [
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "CIRCLECI",
    "JENKINS_URL",
    "BUILDKITE",
    "TRAVIS",
    "TEAMCITY_VERSION",
    "TF_BUILD",
  ].some((k) => process.env[k] !== undefined && process.env[k] !== "");
}

/**
 * Best-effort detection of the AI agent driving the CLI, if any.
 *
 * Not User-Agent regexes — these are env vars the agent runtimes set. Order
 * matters (first match wins): Claude Code, then Cursor. Closed set on purpose.
 */
export function detectAiAgent(): string | undefined {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE) return "claude-code";
  if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_AGENT) return "cursor";
  return undefined;
}

function detectRuntime(): string {
  return (process as unknown as { versions?: { bun?: string } }).versions?.bun ? "bun" : "node";
}

function envTruthy(name: string): boolean {
  const v = process.env[name];
  return v !== undefined && v.trim() !== "" && v.trim().toLowerCase() !== "false" && v.trim() !== "0";
}

export function buildMetadata(input: MetadataInput): Record<string, string> {
  const meta: Record<string, string> = {
    os: process.platform,
    arch: process.arch,
    rt: detectRuntime(),
    status: input.status,
    ci: String(detectIsCi()),
  };

  if (input.durationMs !== undefined) meta.dur_ms = String(input.durationMs);
  if (input.flagNames.length > 0) meta.flags = clip(input.flagNames.join(","));
  if (input.errorType) meta.err_type = clip(input.errorType);
  if (input.productCatalogVersion) meta.pcv = input.productCatalogVersion;
  if (input.generatedResource) meta.code_lang = clip(input.generatedResource);
  if (input.listenPhase) meta.listen_phase = input.listenPhase;

  const agent = detectAiAgent();
  if (agent) meta.agent = agent;

  return meta;
}
