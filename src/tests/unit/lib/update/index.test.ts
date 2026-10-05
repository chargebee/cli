import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Command } from "commander";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setCompiledBinaryForTest,
  __setExecPathForTest,
  __setFsForTest,
  __setInstallMethodForTest,
  __setPlatformForTest,
  __setSpawnSyncForTest,
  __setUpdateTimeoutsForTest,
  cleanupStaleBinary,
  detectInstallMethod,
  fetchLatestVersion,
  githubAssetName,
  isCompiledBinary,
  normalizeVersion,
  npmDistTag,
  otherPackageManagerUpdateMessage,
  persistInstallMethod,
  readInstallMethod,
  resolveGithubToken,
  resolveUpdateChannel,
} from "../../../../lib/update/index.js";
import { registerUpdateCommand } from "../../../../commands/update.js";

describe("registerUpdateCommand", () => {
  it("registers `update` with an `upgrade` alias", () => {
    const program = new Command();
    program.version("1.2.8");
    registerUpdateCommand(program);
    const update = program.commands.find((c) => c.name() === "update");
    expect(update).toBeDefined();
    expect(update?.aliases()).toContain("upgrade");
  });
});

describe("normalizeVersion", () => {
  it("strips leading v", () => {
    expect(normalizeVersion("v1.2.3")).toBe("1.2.3");
  });

  it("keeps a leading v that is not a tag prefix", () => {
    expect(normalizeVersion("vnext")).toBe("vnext");
    expect(normalizeVersion("main")).toBe("main");
  });

  it("trims whitespace", () => {
    expect(normalizeVersion("  1.2.3\n")).toBe("1.2.3");
  });

  it("keeps version when no v prefix", () => {
    expect(normalizeVersion("1.2.3")).toBe("1.2.3");
  });

  it("keeps a semver prerelease suffix", () => {
    expect(normalizeVersion("v1.0.0-beta.1")).toBe("1.0.0-beta.1");
  });

  it("drops trailing extras after whitespace (commander multi-word version)", () => {
    expect(normalizeVersion("1.2.3 (build 42)")).toBe("1.2.3");
  });

  it("handles empty input", () => {
    expect(normalizeVersion("")).toBe("");
  });
});

describe("npmDistTag", () => {
  it("uses beta for a prerelease version", () => {
    expect(npmDistTag("1.0.0-beta.1")).toBe("beta");
  });

  it("uses latest for a public release", () => {
    expect(npmDistTag("1.0.0")).toBe("latest");
  });
});

describe("resolveUpdateChannel", () => {
  it("defaults to stable for a stable copy", () => {
    expect(resolveUpdateChannel(undefined, undefined, "1.0.0")).toBe("stable");
  });

  it("defaults to beta while the running copy is a prerelease", () => {
    expect(resolveUpdateChannel(undefined, undefined, "1.0.0-beta.1")).toBe("beta");
  });

  it("CHARGEBEE_CLI_CHANNEL overrides the default", () => {
    expect(resolveUpdateChannel(undefined, "beta", "1.0.0")).toBe("beta");
    expect(resolveUpdateChannel(undefined, "stable", "1.0.0-beta.1")).toBe("stable");
  });

  it("--channel wins over the env", () => {
    expect(resolveUpdateChannel("stable", "beta", "1.0.0-beta.1")).toBe("stable");
  });

  it("rejects unknown values", () => {
    expect(resolveUpdateChannel("nightly", undefined, "1.0.0")).toBeNull();
    expect(resolveUpdateChannel(undefined, "canary", "1.0.0")).toBeNull();
  });
});

describe("githubAssetName", () => {
  it("matches the release asset naming used by install.sh / install.ps1", () => {
    expect(githubAssetName("darwin", "arm64")).toBe("chargebee-cli-darwin-arm64");
    expect(githubAssetName("darwin", "x64")).toBe("chargebee-cli-darwin-x64");
    expect(githubAssetName("linux", "x64")).toBe("chargebee-cli-linux-x64");
    expect(githubAssetName("linux", "arm64")).toBe("chargebee-cli-linux-arm64");
    expect(githubAssetName("win32", "x64")).toBe("chargebee-cli-windows-x64.exe");
  });
});

describe("resolveGithubToken", () => {
  const original = process.env.GITHUB_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = original;
  });

  it("returns GITHUB_TOKEN when set", () => {
    process.env.GITHUB_TOKEN = "ghp_test";
    expect(resolveGithubToken()).toBe("ghp_test");
  });

  it("passes a timeout to the gh spawn and treats an ETIMEDOUT result as no token", () => {
    delete process.env.GITHUB_TOKEN;
    let capturedOpts: Record<string, unknown> | undefined;
    __setSpawnSyncForTest(((_cmd: string, _args?: readonly string[], opts?: Record<string, unknown>) => {
      capturedOpts = opts;
      return {
        status: null,
        stdout: "",
        stderr: "",
        pid: 1,
        output: [],
        signal: "SIGTERM",
        error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      };
    }) as unknown as typeof import("node:child_process").spawnSync);
    try {
      expect(resolveGithubToken()).toBeNull();
      expect(capturedOpts?.timeout).toBe(5_000);
    } finally {
      __setSpawnSyncForTest(null);
    }
  });
});

describe("install-method marker", () => {
  const previousConfigDir = process.env.CHARGEBEE_CONFIG_DIR;
  let dir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-install-method-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    __setCompiledBinaryForTest(null);
    __setInstallMethodForTest(null);
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (previousConfigDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = previousConfigDir;
    __setCompiledBinaryForTest(null);
    __setInstallMethodForTest(null);
  });

  it("persists and reads github / npm markers", () => {
    persistInstallMethod("github");
    expect(readInstallMethod()).toBe("github");
    persistInstallMethod("npm");
    expect(readInstallMethod()).toBe("npm");
    expect(readFileSync(join(dir!, "install-method"), "utf8").trim()).toBe("npm");
  });

  it("ignores unknown marker values", () => {
    writeFileSync(join(dir!, "install-method"), "brew\n");
    expect(readInstallMethod()).toBeNull();
  });

  it("creates a not-yet-existing config dir 0700", () => {
    if (process.platform === "win32") return;
    const nested = join(dir!, "nested", "config");
    process.env.CHARGEBEE_CONFIG_DIR = nested;
    persistInstallMethod("github");
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });

  it("prefers the marker over the compiled-binary heuristic", () => {
    persistInstallMethod("npm");
    __setCompiledBinaryForTest(true);
    expect(detectInstallMethod()).toBe("npm");
  });

  it("falls back to github for a compiled binary with no marker", () => {
    __setCompiledBinaryForTest(true);
    expect(detectInstallMethod()).toBe("github");
  });

  it("treats a checkout as source instead of guessing npm", () => {
    __setCompiledBinaryForTest(false);
    expect(detectInstallMethod()).toBe("source");
  });

  describe("path-shape heuristics (no marker, no compiled-binary override)", () => {
    const originalArgv1 = process.argv[1];

    beforeEach(() => {
      __setCompiledBinaryForTest(false);
    });

    afterEach(() => {
      process.argv[1] = originalArgv1;
    });

    it("detects a plain npm global install", () => {
      process.argv[1] = "/usr/local/lib/node_modules/@chargebee/cli/dist/index.js";
      expect(detectInstallMethod()).toBe("npm");
    });

    it("detects an npm install through a Windows backslash path", () => {
      process.argv[1] = "C:\\Users\\bob\\AppData\\Roaming\\npm\\node_modules\\@chargebee\\cli\\dist\\index.js";
      expect(detectInstallMethod()).toBe("npm");
    });

    it("detects a pnpm global install instead of guessing npm", () => {
      process.argv[1] =
        "/home/bob/.local/share/pnpm/global/5/.pnpm/@chargebee+cli@1.2.3/node_modules/@chargebee/cli/dist/index.js";
      expect(detectInstallMethod()).toBe("pnpm");
    });

    it("detects a yarn global install instead of guessing npm", () => {
      process.argv[1] = "/home/bob/.config/yarn/global/node_modules/@chargebee/cli/dist/index.js";
      expect(detectInstallMethod()).toBe("yarn");
    });

    it("detects a bun global install instead of guessing npm", () => {
      process.argv[1] = "/home/bob/.bun/install/global/node_modules/@chargebee/cli/dist/index.js";
      expect(detectInstallMethod()).toBe("bun-global");
    });
  });
});

describe("isCompiledBinary", () => {
  const originalArgv = process.argv;
  let scriptDir: string;
  let script: string;

  beforeEach(() => {
    __setCompiledBinaryForTest(null);
    scriptDir = mkdtempSync(join(tmpdir(), "cb-compiled-"));
    script = join(scriptDir, "dist", "index.js");
    mkdirSync(join(scriptDir, "dist"), { recursive: true });
    writeFileSync(script, "");
  });

  afterEach(() => {
    process.argv = originalArgv;
    __setExecPathForTest(null);
    __setCompiledBinaryForTest(null);
    rmSync(scriptDir, { recursive: true, force: true });
  });

  const runtimes = [
    ["bun", "/usr/local/bin/bun"],
    ["node", "/usr/local/bin/node"],
    ["nodejs", "/usr/bin/nodejs"],
    ["a versioned node", "/usr/local/bin/node22"],
    ["an nvm node", "/home/bob/.nvm/versions/node/v22.4.0/bin/node"],
    ["node.exe on Windows", "C:\\Program Files\\nodejs\\node.exe"],
    ["a runtime under a path segment containing 'node'", "/opt/nodeapps/node"],
  ];
  for (const [label, execPath] of runtimes) {
    it(`is false for ${label} running the entry script`, () => {
      __setExecPathForTest(execPath);
      process.argv = [execPath, script, "--version"];
      expect(isCompiledBinary()).toBe(false);
    });
  }

  it("is true for a compiled binary even when an install path segment contains 'bun'", () => {
    __setExecPathForTest("/home/bunny/.local/bin/chargebee");
    process.argv = ["/home/bunny/.local/bin/chargebee", "/$bunfs/root/chargebee-cli", "--version"];
    expect(isCompiledBinary()).toBe(true);
  });

  it("is true for a compiled binary with no argv[1]", () => {
    __setExecPathForTest("/opt/nodeapps/chargebee");
    process.argv = ["/opt/nodeapps/chargebee"];
    expect(isCompiledBinary()).toBe(true);
  });

  it("is true for a compiled .exe on Windows", () => {
    __setExecPathForTest("C:\\Users\\bob\\AppData\\Local\\Chargebee\\bin\\chargebee.exe");
    process.argv = ["C:\\Users\\bob\\AppData\\Local\\Chargebee\\bin\\chargebee.exe", "B:\\~BUN\\root\\chargebee-cli"];
    expect(isCompiledBinary()).toBe(true);
  });
});

describe("otherPackageManagerUpdateMessage", () => {
  it("tells pnpm users to run pnpm, not npm install -g", () => {
    const msg = otherPackageManagerUpdateMessage("pnpm", "1.2.3", "stable");
    expect(msg).toContain("installed with pnpm");
    expect(msg).toContain("pnpm add -g @chargebee/cli@latest");
    expect(msg).not.toContain("npm install");
  });

  it("tells yarn users to run yarn global add", () => {
    const msg = otherPackageManagerUpdateMessage("yarn", "1.2.3-beta.1", "beta");
    expect(msg).toContain("installed with yarn");
    expect(msg).toContain("yarn global add @chargebee/cli@beta");
  });

  it("tells bun users to run bun add -g", () => {
    const msg = otherPackageManagerUpdateMessage("bun-global", null, "beta");
    expect(msg).toContain("installed with bun");
    expect(msg).toContain("bun add -g @chargebee/cli@beta");
  });
});

describe("fetchLatestVersion", () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    process.env.GITHUB_TOKEN = "ghp_test";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  });

  it("returns normalized tag_name on 200", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ tag_name: "v1.5.0" }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchLatestVersion()).toBe("1.5.0");
  });

  it("returns null on non-OK response", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchLatestVersion()).toBeNull();
  });

  it("returns null when tag_name missing", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchLatestVersion()).toBeNull();
  });

  it("returns null on network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await fetchLatestVersion()).toBeNull();
  });

  it("sends Authorization header when token available", async () => {
    let captured: Headers | undefined;
    let capturedUrl = "";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      captured = new Headers(init?.headers);
      return new Response(JSON.stringify({ tag_name: "v2.0.0" }), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchLatestVersion();
    expect(capturedUrl).toEndWith("/releases/latest");
    expect(captured?.get("authorization")).toBe("token ghp_test");
    expect(captured?.get("accept")).toBe("application/vnd.github+json");
  });

  const mixedReleases = [
    { tag_name: "v1.1.0-beta.3", draft: true, prerelease: true },
    { tag_name: "v1.1.0-beta.2", draft: false, prerelease: true },
    { tag_name: "v1.1.0-beta.1", draft: false, prerelease: true },
    { tag_name: "v1.0.0", draft: false, prerelease: false },
  ];

  it("stable channel takes the newest non-draft, non-prerelease release", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(mixedReleases), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchLatestVersion("stable")).toBe("1.0.0");
  });

  it("stable lookup does not depend on the number of newer beta releases", async () => {
    globalThis.fetch = (async (url: string) => {
      expect(String(url)).toEndWith("/releases/latest");
      return new Response(JSON.stringify({ tag_name: "v1.4.0", prerelease: false }));
    }) as unknown as typeof fetch;
    expect(await fetchLatestVersion("stable")).toBe("1.4.0");
  });

  it("beta channel takes the newest non-draft release including prereleases", async () => {
    globalThis.fetch = (async (url: string) => {
      expect(String(url)).toContain("/releases?per_page=");
      return new Response(JSON.stringify(mixedReleases), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchLatestVersion("beta")).toBe("1.1.0-beta.2");
  });

  it("beta channel returns a stable release when that is the newest", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify([{ tag_name: "v1.1.0", draft: false, prerelease: false }, ...mixedReleases]),
        { status: 200 },
      )) as unknown as typeof fetch;
    expect(await fetchLatestVersion("beta")).toBe("1.1.0");
  });

  it("times out instead of hanging forever on a stalled connection", async () => {
    // A fetch that never resolves on its own, but honours the AbortSignal it
    // is given exactly like the real fetch(): this is what a stalled TCP
    // connection looks like from the caller's side.
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
      })) as unknown as typeof fetch;
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
    __setUpdateTimeoutsForTest({ metadata: 20 });
    try {
      expect(await fetchLatestVersion()).toBeNull();
      expect(errors.join("\n")).toContain("timed out after 0.02s");
    } finally {
      console.error = origError;
      __setUpdateTimeoutsForTest(null);
    }
  });
});

type SpawnCall = { cmd: string; args: string[]; opts: Record<string, unknown> };
type SpawnResult = ReturnType<typeof import("node:child_process").spawnSync>;

describe("update action (mocked spawn + fetch)", () => {
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalToken = process.env.GITHUB_TOKEN;
  const originalChannel = process.env.CHARGEBEE_CLI_CHANNEL;
  const originalSkipChecksum = process.env.CHARGEBEE_CLI_SKIP_CHECKSUM;
  const previousConfigDir = process.env.CHARGEBEE_CONFIG_DIR;
  let spawned: SpawnCall[] = [];
  let fetched: { url: string; headers: Headers }[] = [];
  let logs: string[] = [];
  let origLog: typeof console.log;
  let origError: typeof console.error;
  let dir: string | undefined;

  const ASSET_BYTES = "new-binary-bytes";

  function stubSpawn(fn: (cmd: string, args: string[]) => Partial<SpawnResult>): void {
    __setSpawnSyncForTest(((cmd: string, args?: readonly string[], opts?: Record<string, unknown>) => {
      const a = [...(args ?? [])];
      spawned.push({ cmd, args: a, opts: opts ?? {} });
      return { status: 0, stdout: "1.2.9\n", stderr: "", pid: 1, output: [], signal: null, ...fn(cmd, a) };
    }) as unknown as typeof import("node:child_process").spawnSync);
  }

  // A SHA256SUMS.txt body that verifies ASSET_BYTES under every asset name
  // githubAssetName() can produce, so any OS/arch this suite runs under passes.
  const ASSET_HASH = createHash("sha256").update(ASSET_BYTES).digest("hex");
  const VALID_SUMS = [
    "chargebee-cli-darwin-arm64",
    "chargebee-cli-darwin-x64",
    "chargebee-cli-linux-arm64",
    "chargebee-cli-linux-x64",
    "chargebee-cli-windows-x64.exe",
  ]
    .map((name) => `${ASSET_HASH}  ${name}`)
    .join("\n");

  /**
   * api.github.com → release list; .../SHA256SUMS.txt → checksums for
   * ASSET_BYTES (unless `sums` overrides it); .../releases/download/... (or
   * /releases/assets/...) → asset bytes.
   */
  function stubFetch(
    releases: { tag_name: string; draft?: boolean; prerelease?: boolean; assets?: { name: string; url: string }[] }[],
    assetStatus = 200,
    sums: string | null = VALID_SUMS,
  ): void {
    const sumsUrls = new Set(
      releases.flatMap((r) => r.assets ?? []).filter((a) => a.name === "SHA256SUMS.txt").map((a) => a.url),
    );
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      fetched.push({ url: u, headers: new Headers(init?.headers) });
      if (u.startsWith("https://api.github.com/") && !u.includes("/releases/assets/")) {
        return new Response(JSON.stringify(releases), { status: 200 });
      }
      if (u.endsWith("/SHA256SUMS.txt") || sumsUrls.has(u)) {
        return sums === null ? new Response("not found", { status: 404 }) : new Response(sums, { status: 200 });
      }
      if (u.includes("/releases/download/") || u.includes("/releases/assets/")) {
        return new Response(assetStatus === 200 ? ASSET_BYTES : "not found", { status: assetStatus });
      }
      return new Response("unexpected url", { status: 500 });
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    spawned = [];
    fetched = [];
    logs = [];
    origLog = console.log;
    origError = console.error;
    dir = mkdtempSync(join(tmpdir(), "cb-update-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    delete process.env.CHARGEBEE_CLI_CHANNEL;
    delete process.env.CHARGEBEE_CLI_SKIP_CHECKSUM;
    console.log = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    console.error = (...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    };
    process.env.GITHUB_TOKEN = "ghp_test";
    process.exit = ((code?: number) => {
      throw new Error(`exit ${code ?? 0}`);
    }) as typeof process.exit;
    stubSpawn(() => ({}));
    stubFetch([{ tag_name: "v1.2.9" }]);
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origError;
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    __setSpawnSyncForTest(null);
    __setCompiledBinaryForTest(null);
    __setInstallMethodForTest(null);
    __setPlatformForTest(null);
    __setExecPathForTest(null);
    __setFsForTest(null);
    if (dir) {
      try {
        chmodSync(dir, 0o755);
      } catch {}
      rmSync(dir, { recursive: true, force: true });
    }
    dir = undefined;
    if (previousConfigDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = previousConfigDir;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    if (originalChannel === undefined) delete process.env.CHARGEBEE_CLI_CHANNEL;
    else process.env.CHARGEBEE_CLI_CHANNEL = originalChannel;
    if (originalSkipChecksum === undefined) delete process.env.CHARGEBEE_CLI_SKIP_CHECKSUM;
    else process.env.CHARGEBEE_CLI_SKIP_CHECKSUM = originalSkipChecksum;
  });

  async function runUpdate(args: string[] = ["update"], version = "1.2.8"): Promise<void> {
    const program = new Command();
    program.exitOverride();
    program.version(version);
    registerUpdateCommand(program);
    await program.parseAsync(args, { from: "user" });
  }

  function spawnedCmds(): string[] {
    return spawned.map((s) => s.cmd);
  }

  function npmSpec(): string | undefined {
    const call = spawned.find((s) => s.cmd === "npm" || s.cmd === "npm.cmd");
    return call?.args.find((a) => a.startsWith("@chargebee/cli@"));
  }

  it("skips reinstall when already on latest", async () => {
    stubFetch([{ tag_name: "v1.2.8" }]);
    await runUpdate();
    expect(logs.join("\n")).toContain("Already on latest");
    expect(spawnedCmds()).not.toContain("npm");
    expect(spawnedCmds()).not.toContain("curl");
    expect(spawnedCmds()).not.toContain("git");
  });

  it("refuses to guess npm for a source checkout", async () => {
    __setInstallMethodForTest("source");
    await expect(runUpdate()).rejects.toThrow("exit 1");
    expect(logs.join("\n")).toContain("source checkout");
    expect(spawnedCmds()).not.toContain("npm");
    expect(spawnedCmds()).not.toContain("curl");
    expect(spawnedCmds()).not.toContain("git");
  });

  for (const [method, command] of [
    ["pnpm", "pnpm add -g"],
    ["yarn", "yarn global add"],
    ["bun-global", "bun add -g"],
  ] as const) {
    it(`points ${method} installs at their own update command instead of running npm install -g`, async () => {
      __setInstallMethodForTest(method);
      await expect(runUpdate()).rejects.toThrow("exit 1");
      expect(logs.join("\n")).toContain(command);
      expect(spawnedCmds()).not.toContain("npm");
      expect(spawnedCmds()).not.toContain("npm.cmd");
    });
  }

  it("rejects an unknown --channel", async () => {
    __setInstallMethodForTest("npm");
    await expect(runUpdate(["update", "--channel", "nightly"])).rejects.toThrow("exit 1");
    expect(logs.join("\n")).toContain("stable");
    expect(logs.join("\n")).toContain("beta");
    expect(spawnedCmds()).not.toContain("npm");
  });

  describe("npm channel", () => {
    beforeEach(() => {
      __setInstallMethodForTest("npm");
    });

    it("updates via npm and records the marker", async () => {
      await runUpdate();
      expect(spawnedCmds()).toContain("npm");
      expect(npmSpec()).toBe("@chargebee/cli@latest");
      expect(logs.join("\n")).toContain("Updating via npm");
      expect(readInstallMethod()).toBe("npm");
    });

    it("current beta → newest stable ⇒ @latest (no beta lock-in after GA)", async () => {
      stubFetch([
        { tag_name: "v1.1.0", prerelease: false },
        { tag_name: "v1.1.0-beta.1", prerelease: true },
      ]);
      await runUpdate(["update"], "1.1.0-beta.1");
      expect(npmSpec()).toBe("@chargebee/cli@latest");
    });

    it("current beta → newest beta ⇒ @beta", async () => {
      stubFetch([
        { tag_name: "v1.1.0-beta.2", prerelease: true },
        { tag_name: "v1.1.0-beta.1", prerelease: true },
        { tag_name: "v1.0.0", prerelease: false },
      ]);
      await runUpdate(["update"], "1.1.0-beta.1");
      expect(npmSpec()).toBe("@chargebee/cli@beta");
    });

    it("current stable → newer beta exists ⇒ stays on stable (already latest)", async () => {
      stubFetch([
        { tag_name: "v1.1.0-beta.1", prerelease: true },
        { tag_name: "v1.0.0", prerelease: false },
      ]);
      await runUpdate(["update"], "1.0.0");
      expect(logs.join("\n")).toContain("Already on latest");
      expect(spawnedCmds()).not.toContain("npm");
    });

    it("--channel beta opts a stable copy into prereleases", async () => {
      stubFetch([
        { tag_name: "v1.1.0-beta.1", prerelease: true },
        { tag_name: "v1.0.0", prerelease: false },
      ]);
      await runUpdate(["update", "--channel", "beta"], "1.0.0");
      expect(npmSpec()).toBe("@chargebee/cli@beta");
    });

    it("CHARGEBEE_CLI_CHANNEL=beta opts in like the flag", async () => {
      process.env.CHARGEBEE_CLI_CHANNEL = "beta";
      stubFetch([
        { tag_name: "v1.1.0-beta.1", prerelease: true },
        { tag_name: "v1.0.0", prerelease: false },
      ]);
      await runUpdate(["update"], "1.0.0");
      expect(npmSpec()).toBe("@chargebee/cli@beta");
    });

    it("--channel stable pins a beta copy back to @latest", async () => {
      stubFetch([
        { tag_name: "v1.1.0-beta.2", prerelease: true },
        { tag_name: "v1.0.0", prerelease: false },
      ]);
      await runUpdate(["update", "--channel", "stable"], "1.1.0-beta.1");
      expect(npmSpec()).toBe("@chargebee/cli@latest");
    });

    it("falls back to the channel dist-tag when the version check fails", async () => {
      globalThis.fetch = (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch;
      await runUpdate(["update"], "1.1.0-beta.1");
      expect(logs.join("\n")).toContain("could not check latest version");
      expect(npmSpec()).toBe("@chargebee/cli@beta");
    });

    it("--force reinstalls even when already on latest", async () => {
      stubFetch([{ tag_name: "v1.2.8" }]);
      await runUpdate(["update", "--force"]);
      expect(spawnedCmds()).toContain("npm");
      expect(logs.join("\n")).not.toContain("Already on latest");
    });

    it("spawns npm.cmd through a shell on win32", async () => {
      __setPlatformForTest("win32");
      await runUpdate();
      const call = spawned.find((s) => s.args.includes("@chargebee/cli@latest"));
      expect(call?.cmd).toBe("npm.cmd");
      expect(call?.opts.shell).toBe(true);
    });

    it("spawns plain npm without a shell elsewhere", async () => {
      __setPlatformForTest("linux");
      await runUpdate();
      const call = spawned.find((s) => s.args.includes("@chargebee/cli@latest"));
      expect(call?.cmd).toBe("npm");
      expect(call?.opts.shell).toBeFalsy();
    });

    it("explains a spawn error (npm missing / ENOENT) instead of exiting silently", async () => {
      stubSpawn((cmd) =>
        cmd === "npm"
          ? { status: null, error: Object.assign(new Error("spawnSync npm ENOENT"), { code: "ENOENT" }) }
          : {},
      );
      await expect(runUpdate()).rejects.toThrow("exit 1");
      const out = logs.join("\n");
      expect(out).toContain("ENOENT");
      expect(out).toContain("npm install -g @chargebee/cli@latest");
    });

    it("reports the npm exit code and the manual command on failure", async () => {
      stubSpawn((cmd) => (cmd === "npm" ? { status: 243 } : {}));
      await expect(runUpdate(["update"], "1.1.0-beta.1")).rejects.toThrow("exit 1");
      const out = logs.join("\n");
      expect(out).toContain("243");
      expect(out).toContain("npm install -g @chargebee/cli@latest");
    });

    it("passes a timeout to the npm install spawn and reports a clear message on ETIMEDOUT", async () => {
      stubSpawn((cmd) =>
        cmd === "npm"
          ? { status: null, error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }) }
          : {},
      );
      await expect(runUpdate()).rejects.toThrow("exit 1");
      const npmCall = spawned.find((s) => s.cmd === "npm");
      expect(npmCall?.opts.timeout).toBe(300_000);
      expect(logs.join("\n")).toContain("timed out after 300s");
    });
  });

  describe("github channel (unix)", () => {
    let execPath: string;

    beforeEach(() => {
      __setInstallMethodForTest("github");
      __setCompiledBinaryForTest(true);
      __setPlatformForTest("linux");
      execPath = join(dir!, "bin", "chargebee");
      rmSync(join(dir!, "bin"), { recursive: true, force: true });
      mkdirSync(join(dir!, "bin"), { recursive: true });
      writeFileSync(execPath, "old-binary-bytes");
      chmodSync(execPath, 0o755);
      __setExecPathForTest(execPath);
    });

    it("refuses to replace an executable named like a JavaScript runtime", async () => {
      const runtimes = ["node", "nodejs", "node22", "bun", "bunx", "deno", "node.exe", "Node.EXE"];
      for (const name of runtimes) {
        const runtime = join(dir!, "bin", name);
        writeFileSync(runtime, "runtime-bytes");
        __setExecPathForTest(runtime);
        fetched = [];
        await expect(runUpdate()).rejects.toThrow("exit 1");
        expect(readFileSync(runtime, "utf8")).toBe("runtime-bytes");
        expect(existsSync(`${runtime}.new`)).toBe(false);
        expect(fetched.some((f) => f.url.includes("/releases/download/"))).toBe(false);
        expect(logs.join("\n")).toContain("JavaScript runtime");
      }
    });

    it("downloads the exact tag's asset and atomically replaces the running binary", async () => {
      await runUpdate();

      expect(readFileSync(execPath, "utf8")).toBe(ASSET_BYTES);
      expect(statSync(execPath).mode & 0o777).toBe(0o755);
      expect(existsSync(`${execPath}.new`)).toBe(false);

      const assetReq = fetched.find((f) => f.url.includes("/releases/download/"));
      expect(assetReq?.url).toBe(
        `https://github.com/chargebee/cli/releases/download/v1.2.9/${githubAssetName("linux", process.arch)}`,
      );
      expect(assetReq?.headers.get("authorization")).toBe("token ghp_test");
      for (const f of fetched) {
        expect(f.url).not.toContain("/main/");
        expect(f.url).not.toContain("/releases/latest/");
      }

      expect(spawnedCmds()).not.toContain("bash");
      expect(spawnedCmds()).not.toContain("curl");
      expect(spawnedCmds()).not.toContain("git");
      for (const s of spawned) {
        expect(s.args.join(" ")).not.toContain("ghp_test");
      }
      expect(logs.join("\n")).toContain("Updating via GitHub Releases");
      expect(logs.join("\n")).toContain("Updated: 1.2.8 →");
      expect(readInstallMethod()).toBe("github");
    });

    it("prefers the release's API asset URL (works for private repos) with an octet-stream Accept", async () => {
      stubFetch([
        {
          tag_name: "v1.2.9",
          assets: [
            { name: "chargebee-cli-windows-x64.exe", url: "https://api.github.com/repos/chargebee/cli/releases/assets/1" },
            { name: githubAssetName("linux", process.arch), url: "https://api.github.com/repos/chargebee/cli/releases/assets/2" },
            { name: "SHA256SUMS.txt", url: "https://api.github.com/repos/chargebee/cli/releases/assets/3" },
          ],
        },
      ]);
      await runUpdate();
      const assetReq = fetched.find((f) => f.url.endsWith("/releases/assets/2"));
      expect(assetReq).toBeDefined();
      expect(assetReq?.headers.get("accept")).toBe("application/octet-stream");
      expect(assetReq?.headers.get("authorization")).toBe("token ghp_test");
      expect(fetched.some((f) => f.url.includes("/releases/download/"))).toBe(false);
      expect(readFileSync(execPath, "utf8")).toBe(ASSET_BYTES);
    });

    it("uses the release's own tag_name for the download URL", async () => {
      stubFetch([{ tag_name: "1.2.9" }]);
      await runUpdate();
      const assetReq = fetched.find((f) => f.url.includes("/releases/download/"));
      expect(assetReq?.url).toContain("/releases/download/1.2.9/");
    });

    it("downloads the prerelease tag when the beta channel picked one", async () => {
      stubFetch([
        { tag_name: "v1.3.0-beta.1", prerelease: true },
        { tag_name: "v1.2.9", prerelease: false },
      ]);
      await runUpdate(["update"], "1.2.9-beta.1");
      const assetReq = fetched.find((f) => f.url.includes("/releases/download/"));
      expect(assetReq?.url).toContain("/releases/download/v1.3.0-beta.1/");
    });

    it("refuses to guess a tag when the version check failed", async () => {
      globalThis.fetch = (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch;
      await expect(runUpdate()).rejects.toThrow("exit 1");
      expect(logs.join("\n")).toContain("install.sh");
      expect(readFileSync(execPath, "utf8")).toBe("old-binary-bytes");
    });

    it("exits with the HTTP status when the asset cannot be downloaded", async () => {
      stubFetch([{ tag_name: "v1.2.9" }], 404);
      await expect(runUpdate()).rejects.toThrow("exit 1");
      expect(logs.join("\n")).toContain("404");
      expect(readFileSync(execPath, "utf8")).toBe("old-binary-bytes");
      expect(existsSync(`${execPath}.new`)).toBe(false);
    });

    it("times out the asset download instead of hanging on a stalled connection", async () => {
      globalThis.fetch = (async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith("https://api.github.com/")) {
          return new Response(JSON.stringify([{ tag_name: "v1.2.9" }]), { status: 200 });
        }
        // The asset download never resolves on its own; only the AbortSignal ends it.
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
        });
      }) as unknown as typeof fetch;
      __setUpdateTimeoutsForTest({ asset: 20 });
      try {
        await expect(runUpdate()).rejects.toThrow("exit 1");
        expect(logs.join("\n")).toContain("timed out after 0.02s");
        expect(readFileSync(execPath, "utf8")).toBe("old-binary-bytes");
        expect(existsSync(`${execPath}.new`)).toBe(false);
      } finally {
        __setUpdateTimeoutsForTest(null);
      }
    });

    it("verifies the downloaded asset against SHA256SUMS.txt before replacing the binary", async () => {
      await runUpdate();
      const sumsReq = fetched.find((f) => f.url.endsWith("/SHA256SUMS.txt"));
      expect(sumsReq?.url).toBe("https://github.com/chargebee/cli/releases/download/v1.2.9/SHA256SUMS.txt");
      expect(readFileSync(execPath, "utf8")).toBe(ASSET_BYTES);
    });

    it("aborts and leaves the current binary intact when the checksum does not match", async () => {
      stubFetch([{ tag_name: "v1.2.9" }], 200, "0000000000000000000000000000000000000000000000000000000000000000  chargebee-cli-linux-x64\n0000000000000000000000000000000000000000000000000000000000000000  chargebee-cli-linux-arm64");
      await expect(runUpdate()).rejects.toThrow("exit 1");
      expect(logs.join("\n")).toContain("checksum verification failed");
      expect(readFileSync(execPath, "utf8")).toBe("old-binary-bytes");
      expect(existsSync(`${execPath}.new`)).toBe(false);
    });

    it("aborts and leaves the current binary intact when SHA256SUMS.txt cannot be downloaded", async () => {
      stubFetch([{ tag_name: "v1.2.9" }], 200, null);
      await expect(runUpdate()).rejects.toThrow("exit 1");
      expect(logs.join("\n")).toContain("could not download SHA256SUMS.txt");
      expect(readFileSync(execPath, "utf8")).toBe("old-binary-bytes");
      expect(existsSync(`${execPath}.new`)).toBe(false);
    });

    it("CHARGEBEE_CLI_SKIP_CHECKSUM=1 skips verification and warns", async () => {
      process.env.CHARGEBEE_CLI_SKIP_CHECKSUM = "1";
      stubFetch([{ tag_name: "v1.2.9" }], 200, null);
      await runUpdate();
      expect(logs.join("\n")).toContain("skipping checksum verification");
      expect(fetched.some((f) => f.url.endsWith("/SHA256SUMS.txt"))).toBe(false);
      expect(readFileSync(execPath, "utf8")).toBe(ASSET_BYTES);
    });

    it.skipIf(process.getuid?.() === 0)(
      "prints the install.sh command instead of relocating when the install dir is not writable",
      async () => {
        chmodSync(join(dir!, "bin"), 0o555);
        try {
          await expect(runUpdate()).rejects.toThrow("exit 1");
        } finally {
          chmodSync(join(dir!, "bin"), 0o755);
        }
        const out = logs.join("\n");
        expect(out).toContain("not writable");
        expect(out).toContain("install.sh");
        expect(out).toContain(`CHARGEBEE_CLI_BIN_DIR=${realpathSync(join(dir!, "bin"))}`);
        expect(out).toContain("CHARGEBEE_CLI_NO_ONBOARDING=1");
        expect(out).toContain("CHARGEBEE_CLI_VERSION=v1.2.9");
        expect(readFileSync(execPath, "utf8")).toBe("old-binary-bytes");
        expect(spawnedCmds()).not.toContain("sudo");
      },
    );
  });

  describe("github channel (win32, mocked fs)", () => {
    const EXE = "C:\\Users\\me\\AppData\\Local\\Chargebee\\bin\\chargebee.exe";
    let ops: string[];
    let files: Map<string, string>;

    function mockFs(failSecondRename = false) {
      ops = [];
      files = new Map([[EXE, "old-binary-bytes"]]);
      let renames = 0;
      __setFsForTest({
        realpathSync: ((p: string) => p) as unknown as typeof import("node:fs").realpathSync,
        writeFileSync: ((p: string, data: Buffer | string) => {
          ops.push(`write ${p}`);
          files.set(p, data.toString());
        }) as unknown as typeof import("node:fs").writeFileSync,
        chmodSync: ((p: string) => {
          ops.push(`chmod ${p}`);
        }) as unknown as typeof import("node:fs").chmodSync,
        rmSync: ((p: string) => {
          ops.push(`rm ${p}`);
          files.delete(p);
        }) as unknown as typeof import("node:fs").rmSync,
        renameSync: ((from: string, to: string) => {
          renames += 1;
          ops.push(`rename ${from} -> ${to}`);
          if (failSecondRename && renames === 2) {
            throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
          }
          files.set(to, files.get(from)!);
          files.delete(from);
        }) as unknown as typeof import("node:fs").renameSync,
        unlinkSync: ((p: string) => {
          ops.push(`unlink ${p}`);
          if (!files.has(p)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          files.delete(p);
        }) as unknown as typeof import("node:fs").unlinkSync,
      });
    }

    beforeEach(() => {
      __setInstallMethodForTest("github");
      __setCompiledBinaryForTest(true);
      __setPlatformForTest("win32");
      __setExecPathForTest(EXE);
      mockFs();
    });

    it("downloads beside the exe, renames the running exe to .old, then .new into place", async () => {
      await runUpdate();
      expect(ops).toEqual([
        `write ${EXE}.new`,
        `rm ${EXE}.old`,
        `rename ${EXE} -> ${EXE}.old`,
        `rename ${EXE}.new -> ${EXE}`,
      ]);
      expect(files.get(EXE)).toBe(ASSET_BYTES);
      expect(files.get(`${EXE}.old`)).toBe("old-binary-bytes");
      expect(files.has(`${EXE}.new`)).toBe(false);
      const assetReq = fetched.find((f) => f.url.includes("/releases/download/"));
      expect(assetReq?.url).toBe(
        "https://github.com/chargebee/cli/releases/download/v1.2.9/chargebee-cli-windows-x64.exe",
      );
      expect(spawnedCmds()).not.toContain("curl");
      expect(readInstallMethod()).toBe("github");
    });

    it("rolls the old exe back when the second rename fails", async () => {
      mockFs(true);
      await expect(runUpdate()).rejects.toThrow("exit 1");
      expect(ops).toEqual([
        `write ${EXE}.new`,
        `rm ${EXE}.old`,
        `rename ${EXE} -> ${EXE}.old`,
        `rename ${EXE}.new -> ${EXE}`,
        `rename ${EXE}.old -> ${EXE}`,
        `rm ${EXE}.new`,
      ]);
      expect(files.get(EXE)).toBe("old-binary-bytes");
      expect(logs.join("\n")).toContain("could not replace");
    });

    it("refuses to update a non-compiled copy on Windows", async () => {
      __setCompiledBinaryForTest(false);
      await expect(runUpdate()).rejects.toThrow("exit 1");
      expect(ops).toEqual([]);
      expect(logs.join("\n")).toContain("chargebee-cli-windows-x64.exe");
    });

    it("cleanupStaleBinary unlinks <exe>.old on win32 and swallows errors", () => {
      files.set(`${EXE}.old`, "stale");
      cleanupStaleBinary();
      expect(ops).toEqual([`unlink ${EXE}.old`]);
      expect(files.has(`${EXE}.old`)).toBe(false);
      // Second run: nothing to delete, must not throw.
      expect(() => cleanupStaleBinary()).not.toThrow();
    });

    it("cleanupStaleBinary is a no-op off Windows and for non-compiled copies", () => {
      __setPlatformForTest("linux");
      cleanupStaleBinary();
      __setPlatformForTest("win32");
      __setCompiledBinaryForTest(false);
      cleanupStaleBinary();
      expect(ops).toEqual([]);
    });
  });
});
