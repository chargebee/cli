import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clearCiEnv } from "../../lib/test-support/_helpers.js";
import { BATCH_SIZE, ENV_FLUSH_CHILD, FLUSH_COMMAND } from "../../lib/telemetry/constants.js";

let restoreCiEnv: () => void;
beforeEach(() => { restoreCiEnv = clearCiEnv(); });
afterEach(() => restoreCiEnv());

/**
 * An `npm i -g` install runs `dist/index.js` under Node through an
 * extensionless bin symlink (`<prefix>/bin/chargebee`). The detached flush child
 * must be launched with the resolved script, or telemetry never leaves the
 * machine. Copies the selected npm bundle into a fake global
 * prefix and drives it through a POSIX bin symlink or the Windows Node entry point. The
 * network is stubbed via `NODE_OPTIONS=--require` (inherited by the flush
 * child) so nothing is ever posted to the real ingest host.
 */
const nodeBin = process.env.CHARGEBEE_CLI_NODE;

async function removeTempDir(path: string): Promise<void> {
  // Bun's Windows rm can return EBUSY without honoring maxRetries.
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 50 || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(code ?? "")) throw error;
      await Bun.sleep(100);
    }
  }
}

describe.skipIf(!nodeBin)("telemetry flush child via the npm entry point", () => {
  let prefix: string;
  let bin: string;
  let stub: string;
  let configDir: string;
  let postsFile: string;
  let spoolFile: string;

  beforeAll(() => {
    prefix = mkdtempSync(join(tmpdir(), "cb-npm-prefix-"));
    const pkgDist = join(prefix, "lib", "node_modules", "@chargebee", "cli", "dist");
    mkdirSync(pkgDist, { recursive: true });
    copyFileSync(resolve(process.env.CHARGEBEE_CLI_BINARY!), join(pkgDist, "index.js"));
    mkdirSync(join(prefix, "bin"));
    bin = join(prefix, "bin", "chargebee");
    if (process.platform === "win32") bin = join(pkgDist, "index.js");
    else symlinkSync(join("..", "lib", "node_modules", "@chargebee", "cli", "dist", "index.js"), bin);

    stub = join(prefix, "stub-fetch.cjs");
    writeFileSync(
      stub,
      [
        'const fs = require("node:fs");',
        "globalThis.fetch = async (url, init) => {",
        "  const body = JSON.parse(String(init && init.body));",
        '  fs.appendFileSync(process.env.TELEMETRY_STUB_OUT, JSON.stringify({ url: String(url), body }) + "\\n");',
        '  return new Response("ok", { status: 200 });',
        "};",
        "",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    if (prefix) await removeTempDir(prefix);
  }, 10_000);

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "cb-npm-config-"));
    postsFile = join(configDir, "posts.ndjson");
    spoolFile = join(configDir, "telemetry-spool.ndjson");
    // The notice has already been shown on an earlier run, so this run records.
    writeFileSync(
      join(configDir, "telemetry.json"),
      JSON.stringify({ enabled: true, notice_shown: true, anonymous_id: "vid-npm-test" }),
    );
  });

  afterEach(async () => {
    // Delivery can finish before the detached child exits. Windows keeps its cwd
    // locked until exit; retry cleanup briefly, but still fail if it stays locked.
    if (configDir) await removeTempDir(configDir);
  }, 10_000);

  function run(args: string[], extraEnv: Record<string, string> = {}) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, {
      CHARGEBEE_CONFIG_DIR: configDir,
      CHARGEBEE_SITE: "",
      CHARGEBEE_API_KEY: "",
      NODE_OPTIONS: `--require ${JSON.stringify(stub)}`,
      TELEMETRY_STUB_OUT: postsFile,
      ...extraEnv,
    });
    const proc = Bun.spawnSync(process.platform === "win32" ? [nodeBin!, bin, ...args] : [bin, ...args], { cwd: configDir, env, stdout: "pipe", stderr: "pipe" });
    return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode };
  }

  function seedSpool(n: number): void {
    for (let i = 0; i < n; i++) {
      appendFileSync(
        spoolFile,
        JSON.stringify({
          env: "production",
          site_name: "unconfigured",
          visitor_id: "vid-npm-test",
          cli_version: "0.0.0-seed",
          event: { name: `seed${i}`, timestamp: new Date().toISOString(), metadata: {} },
        }) + "\n",
      );
    }
  }

  function readPosts(): Array<{ url: string; body: { events: Array<{ name: string }>; site_name: string; visitor_id: string } }> {
    if (!existsSync(postsFile)) return [];
    return readFileSync(postsFile, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  async function waitFor(pred: () => boolean, ms = 20_000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return true;
      await Bun.sleep(100);
    }
    return pred();
  }

  it.skipIf(process.platform !== "win32")("waits for a child to release its working directory during cleanup", async () => {
    const lockedDir = join(configDir, "locked");
    mkdirSync(lockedDir);
    const ready = join(configDir, "child-ready");
    const child = Bun.spawn([
      nodeBin!, "-e",
      'require("node:fs").writeFileSync(process.argv[1], "ready"); process.stdin.resume(); process.stdin.once("end", () => process.exit(0));',
      ready,
    ], { cwd: lockedDir, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    try {
      expect(await waitFor(() => existsSync(ready))).toBe(true);
      // Confirm this runner reproduces the Windows cwd lock before testing retries.
      await expect(rm(lockedDir, { recursive: true, force: true })).rejects.toMatchObject({ code: "EBUSY" });
      const cleanup = removeTempDir(lockedDir);
      child.stdin.end();
      await cleanup;
      expect(existsSync(lockedDir)).toBe(false);
      expect(await child.exited).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
    }
  }, 10_000);

  it("spools the command under Node and drains it through the flush entry", () => {
    const res = run(["telemetry", "status"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Telemetry");

    expect(existsSync(spoolFile)).toBe(true);
    const lines = readFileSync(spoolFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec.event.name).toBe("telemetry status");
    expect(rec.event.metadata.rt).toBe("node");
    expect(rec.visitor_id).toBe("vid-npm-test");

    // Invoke the hidden flush entry point exactly as the detached child would.
    const flush = run([FLUSH_COMMAND], { [ENV_FLUSH_CHILD]: "1" });
    expect(flush.exitCode).toBe(0);
    const posts = readPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].body.visitor_id).toBe("vid-npm-test");
    expect(posts[0].body.site_name).toBe("unconfigured");
    expect(posts[0].body.events.map((e) => e.name)).toEqual(["telemetry status"]);
    expect(existsSync(spoolFile)).toBe(false);
  }, 30_000);

  it("spawns a working detached flush child once the spool reaches BATCH_SIZE", async () => {
    seedSpool(BATCH_SIZE - 1);
    const res = run(["telemetry", "status"]);
    expect(res.exitCode).toBe(0);

    // The child is detached and outlives the parent; wait for it to post.
    // Seeded records and this command use different CLI versions, so the flush
    // can POST more than one batch. Spool rotation is not delivery completion.
    expect(await waitFor(() =>
      readPosts().reduce((count, post) => count + post.body.events.length, 0) >= BATCH_SIZE,
    )).toBe(true);
    expect(await waitFor(() => !existsSync(spoolFile))).toBe(true);
    const events = readPosts().flatMap((p) => p.body.events.map((e) => e.name));
    expect(events).toHaveLength(BATCH_SIZE);
    expect(events).toContain("telemetry status");
  }, 30_000);
});
