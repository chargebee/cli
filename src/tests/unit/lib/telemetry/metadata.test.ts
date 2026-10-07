import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  buildMetadata,
  detectAiAgent,
  isTerminal,
  normalizeGeneratedResource,
  runtimeVersion,
} from "../../../../lib/telemetry/metadata.js";

describe("buildMetadata duration", () => {
  it("includes dur_ms when provided", () => {
    const meta = buildMetadata({
      flagNames: [],
      durationMs: 123,
      status: "ok",
    });
    expect(meta.dur_ms).toBe("123");
    expect("duration_ms" in meta).toBe(false);
  });

  it("omits dur_ms when undefined (interactive command)", () => {
    const meta = buildMetadata({
      flagNames: [],
      durationMs: undefined,
      status: "ok",
    });
    expect("dur_ms" in meta).toBe(false);
  });
});

describe("buildMetadata flags", () => {
  it("joins flag names with commas and omits when empty", () => {
    expect(
      buildMetadata({ flagNames: ["json", "fields"], durationMs: 1, status: "ok" }).flags,
    ).toBe("json,fields");
    expect(
      "flags" in buildMetadata({ flagNames: [], durationMs: 1, status: "ok" }),
    ).toBe(false);
  });
});

describe("buildMetadata allow-list", () => {
  it("does not put the command path in metadata", () => {
    const meta = buildMetadata({ flagNames: [], status: "ok" });
    expect("command" in meta).toBe(false);
  });

  it("emits listen_phase when provided", () => {
    const meta = buildMetadata({
      flagNames: ["forward-to"],
      status: "ok",
      listenPhase: "established",
    });
    expect(meta.listen_phase).toBe("established");
    expect("dur_ms" in meta).toBe(false);
  });

  it("emits short keys: pcv, code_lang, rt, ci, err_type", () => {
    const meta = buildMetadata({
      flagNames: [],
      status: "error",
      errorType: "api_404",
      productCatalogVersion: "v2",
      generatedResource: "go",
    });
    expect(meta.pcv).toBe("v2");
    expect(meta.code_lang).toBe("go");
    expect(meta.err_type).toBe("api_404");
    expect(meta.rt).toMatch(/^(node|bun)$/);
    expect(meta.ci).toMatch(/^(true|false)$/);
    expect("runtime" in meta).toBe(false);
    expect("is_ci" in meta).toBe(false);
    expect("error_type" in meta).toBe(false);
    expect("product_catalog_version" in meta).toBe(false);
    expect("generated_resource" in meta).toBe(false);
    expect("code_sample_language" in meta).toBe(false);
    expect("ai_agent" in meta).toBe(false);
  });
});

describe("buildMetadata runtime context", () => {
  it("emits the runtime major.minor as rtv", () => {
    const meta = buildMetadata({ flagNames: [], status: "ok" });
    expect(meta.rtv).toMatch(/^\d+\.\d+$/);
  });

  it("emits tty as a boolean string", () => {
    const meta = buildMetadata({ flagNames: [], status: "ok" });
    expect(meta.tty).toMatch(/^(true|false)$/);
  });

  it("emits im and first_run only when provided", () => {
    const bare = buildMetadata({ flagNames: [], status: "ok" });
    expect("im" in bare).toBe(false);
    expect("first_run" in bare).toBe(false);
    const meta = buildMetadata({ flagNames: [], status: "ok", installMethod: "npm", firstRun: "2026-10-07" });
    expect(meta.im).toBe("npm");
    expect(meta.first_run).toBe("2026-10-07");
  });
});

describe("runtimeVersion", () => {
  it("reduces a version to major.minor", () => {
    expect(runtimeVersion({ node: "22.12.0" })).toBe("22.12");
    expect(runtimeVersion({ node: "24.1.3", bun: "1.3.14" })).toBe("1.3");
    expect(runtimeVersion({})).toBe("unknown");
  });
});

describe("isTerminal", () => {
  it("is true only when both stdin and stdout are TTYs", () => {
    expect(isTerminal({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(isTerminal({ isTTY: false }, { isTTY: true })).toBe(false);
    expect(isTerminal({}, { isTTY: true })).toBe(false);
  });
});

describe("normalizeGeneratedResource", () => {
  it("accepts known languages, lower-cased and trimmed", () => {
    expect(normalizeGeneratedResource("curl")).toBe("curl");
    expect(normalizeGeneratedResource("GO")).toBe("go");
    expect(normalizeGeneratedResource("  NodeJS ")).toBe("js");
  });

  it("collapses node aliases to js", () => {
    expect(normalizeGeneratedResource("node")).toBe("js");
    expect(normalizeGeneratedResource("nodejs")).toBe("js");
    expect(normalizeGeneratedResource("javascript")).toBe("js");
  });

  it("drops the `list` meta-action", () => {
    expect(normalizeGeneratedResource("list")).toBeUndefined();
    expect(normalizeGeneratedResource("LIST")).toBeUndefined();
  });

  it("drops unknown values and non-strings", () => {
    expect(normalizeGeneratedResource("banana")).toBeUndefined();
    expect(normalizeGeneratedResource("")).toBeUndefined();
    expect(normalizeGeneratedResource(undefined)).toBeUndefined();
    expect(normalizeGeneratedResource(42)).toBeUndefined();
  });
});

describe("detectAiAgent", () => {
  const keys = [
    "CLAUDECODE",
    "CLAUDE_CODE",
    "CURSOR_TRACE_ID",
    "CURSOR_AGENT",
    "AIDER_VERSION",
    "GITHUB_COPILOT_CLI",
    "CODEX_SANDBOX",
    "CODEX_SANDBOX_NETWORK_DISABLED",
    "GEMINI_CLI",
  ];
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of keys) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  it("returns claude-code for CLAUDECODE", () => {
    process.env.CLAUDECODE = "1";
    expect(detectAiAgent()).toBe("claude-code");
  });

  it("returns cursor for CURSOR_AGENT", () => {
    process.env.CURSOR_AGENT = "1";
    expect(detectAiAgent()).toBe("cursor");
  });

  it("returns codex for either Codex sandbox marker", () => {
    process.env.CODEX_SANDBOX = "seatbelt";
    expect(detectAiAgent()).toBe("codex");
    delete process.env.CODEX_SANDBOX;
    process.env.CODEX_SANDBOX_NETWORK_DISABLED = "1";
    expect(detectAiAgent()).toBe("codex");
  });

  it("returns gemini-cli for GEMINI_CLI", () => {
    process.env.GEMINI_CLI = "1";
    expect(detectAiAgent()).toBe("gemini-cli");
  });

  it("ignores Aider and Copilot", () => {
    process.env.AIDER_VERSION = "0.1";
    process.env.GITHUB_COPILOT_CLI = "1";
    expect(detectAiAgent()).toBeUndefined();
  });
});
