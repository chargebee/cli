/**
 * macOS / Linux keychain subprocess shape: secret placement, timeouts, and
 * timeout error mapping. Stubs `spawnSync` — nothing here shells out.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { SpawnSyncReturns } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  __setSpawnSyncForTest,
  getProfileKey,
  keychainDisabledReason,
  keychainEnabled,
  KeychainUnavailableError,
  linuxSecretToolStore,
  macosSecurityStore,
  windowsCredentialStore,
  __setKeychainForTest,
  __resetKeychainForTest,
} from "../../../../lib/config/keychain.js";

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  opts: Record<string, unknown>;
}

function ok(stdout = ""): SpawnSyncReturns<string> {
  return { status: 0, signal: null, stdout, stderr: "", pid: 1, output: [null, stdout, ""] };
}

function timedOut(): SpawnSyncReturns<string> {
  const error = Object.assign(new Error("spawnSync ETIMEDOUT"), { code: "ETIMEDOUT" });
  return { status: null, signal: "SIGTERM", stdout: "", stderr: "", pid: 1, output: [null, "", ""], error };
}

function stubSpawnSync(handler: (call: SpawnCall) => SpawnSyncReturns<string>): SpawnCall[] {
  const calls: SpawnCall[] = [];
  __setSpawnSyncForTest(((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    const call = { cmd, args, opts };
    calls.push(call);
    return handler(call);
  }) as never);
  return calls;
}

afterEach(() => {
  __setSpawnSyncForTest(null);
  __resetKeychainForTest();
});

describe("macOS keychain store", () => {
  it("never puts the secret on argv; runs `security -i` with the hex-encoded secret on stdin", async () => {
    const calls = stubSpawnSync(() => ok());
    await macosSecurityStore().set("prod", "live_supersecret");
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("/usr/bin/security");
    expect(calls[0].args).toEqual(["-i"]);
    const hex = Buffer.from("live_supersecret", "utf8").toString("hex");
    expect(calls[0].opts.input).toBe(`add-generic-password -U -s chargebee-cli -a "profile:prod" -X ${hex}\n`);
    expect(String(calls[0].opts.input)).not.toContain("live_supersecret");
  });

  it("rejects account names that could break out of the -i command line without spawning", async () => {
    const calls = stubSpawnSync(() => ok());
    const store = macosSecurityStore();
    for (const bad of ['pr"od', "pr\\od", "pr\nod", "pr\x7fod"]) {
      await expect(store.set(bad, "live_x")).rejects.toThrow(/cannot be stored in the macOS keychain/);
    }
    expect(calls).toHaveLength(0);
  });

  it("surfaces a non-zero `security -i` exit as a write failure", async () => {
    stubSpawnSync(() => ({ ...ok(), status: 51, stderr: "security: SecKeychainItemCreateFromContent: The user name or passphrase you entered is not correct.\nadd-generic-password: returned -25293" }));
    await expect(macosSecurityStore().set("prod", "live_x")).rejects.toThrow(/passphrase/);
  });

  it("passes a 10s timeout on get, set, and delete", async () => {
    const calls = stubSpawnSync(() => ok());
    const store = macosSecurityStore();
    await store.get("prod");
    await store.set("prod", "live_x");
    await store.delete("prod");
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.opts.timeout).toBe(10_000);
  });

  it("maps a timed-out read to KeychainUnavailableError", async () => {
    stubSpawnSync(() => timedOut());
    __setKeychainForTest(macosSecurityStore());
    const err = await getProfileKey("prod").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeychainUnavailableError);
    expect((err as Error).message).toContain("timed out");
  });
});

describe("Linux keychain store", () => {
  it("already sends the secret on stdin, never argv", async () => {
    const calls = stubSpawnSync((call) => (call.cmd === "which" ? { ...ok("/usr/bin/secret-tool") } : ok()));
    await linuxSecretToolStore().set("prod", "live_supersecret");
    const storeCall = calls.find((c) => c.args[0] === "store")!;
    expect(storeCall.args.join(" ")).not.toContain("live_supersecret");
    expect(storeCall.opts.input).toBe("live_supersecret");
  });

  it("passes a 10s timeout on get, set, and delete", async () => {
    const calls = stubSpawnSync((call) => (call.cmd === "which" ? { ...ok("/usr/bin/secret-tool") } : ok()));
    const store = linuxSecretToolStore();
    await store.get("prod");
    await store.set("prod", "live_x");
    await store.delete("prod");
    const toolCalls = calls.filter((c) => c.cmd !== "which");
    expect(toolCalls).toHaveLength(3);
    for (const call of toolCalls) expect(call.opts.timeout).toBe(10_000);
  });

  it("maps a timed-out read to KeychainUnavailableError", async () => {
    stubSpawnSync((call) => (call.cmd === "which" ? { ...ok("/usr/bin/secret-tool") } : timedOut()));
    __setKeychainForTest(linuxSecretToolStore());
    const err = await getProfileKey("prod").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeychainUnavailableError);
    expect((err as Error).message).toContain("timed out");
  });
});

describe("keychain account scoping by config dir", () => {
  function withConfigDir<T>(dir: string | undefined, fn: () => T): T {
    const previous = process.env.CHARGEBEE_CONFIG_DIR;
    if (dir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = dir;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
      else process.env.CHARGEBEE_CONFIG_DIR = previous;
    }
  }

  it("uses the unscoped account for the default config dir (CHARGEBEE_CONFIG_DIR unset)", async () => {
    const calls = stubSpawnSync(() => ok());
    await withConfigDir(undefined, () => macosSecurityStore().set("prod", "live_x"));
    expect(String(calls[0].opts.input)).toContain('-a "profile:prod" ');
  });

  it("scopes the account to a hash of CHARGEBEE_CONFIG_DIR when it is set", async () => {
    const calls = stubSpawnSync(() => ok());
    await withConfigDir("/tmp/custom-chargebee-dir", () => macosSecurityStore().set("prod", "live_x"));
    const input = String(calls[0].opts.input);
    expect(input).toMatch(/-a "profile:prod@[0-9a-f]{8}" /);
    expect(input).not.toContain('-a "profile:prod" ');
  });

  it("resolves the config dir before hashing, so a trailing slash or `.` segment yields the same account", async () => {
    const calls = stubSpawnSync(() => ok());
    await withConfigDir("/tmp/custom-chargebee-dir", () => macosSecurityStore().set("prod", "live_x"));
    await withConfigDir("/tmp/custom-chargebee-dir/", () => macosSecurityStore().set("prod", "live_x"));
    await withConfigDir("/tmp/custom-chargebee-dir/./", () => macosSecurityStore().set("prod", "live_x"));
    const [a, b, c] = calls.map((call) => String(call.opts.input));
    expect(a).toMatch(/-a "profile:prod@[0-9a-f]{8}" /);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("keeps the unscoped account when CHARGEBEE_CONFIG_DIR spells out the default dir", async () => {
    const calls = stubSpawnSync(() => ok());
    const defaultDir = join(process.env.HOME || homedir(), ".chargebee", "cli");
    await withConfigDir(`${defaultDir}/`, () => macosSecurityStore().set("prod", "live_x"));
    expect(String(calls[0].opts.input)).toContain('-a "profile:prod" ');
  });

  it("falls back to the unscoped account on a scoped miss and moves the item over (macOS)", async () => {
    const previousHome = process.env.HOME;
    const previousConfigDir = process.env.CHARGEBEE_CONFIG_DIR;
    process.env.HOME = "/tmp/cb-kc-no-such-home";
    process.env.CHARGEBEE_CONFIG_DIR = "/tmp/custom-chargebee-dir";
    const items = new Map<string, string>([["profile:prod", "live_legacy"]]);
    const calls = stubSpawnSync((call) => {
      if (call.args[0] === "find-generic-password") {
        const secret = items.get(String(call.args[4]));
        return secret ? ok(`${secret}\n`) : { ...ok(), status: 44, stderr: "The specified item could not be found in the keychain." };
      }
      if (call.args[0] === "-i") {
        const m = /-a "([^"]+)" -X ([0-9a-f]+)/.exec(String(call.opts.input))!;
        items.set(m[1], Buffer.from(m[2], "hex").toString("utf8"));
        return ok();
      }
      if (call.args[0] === "delete-generic-password") {
        items.delete(String(call.args[4]));
        return ok();
      }
      return ok();
    });
    try {
      expect(await macosSecurityStore().get("prod")).toBe("live_legacy");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousConfigDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
      else process.env.CHARGEBEE_CONFIG_DIR = previousConfigDir;
    }
    const lookups = calls.filter((c) => c.args[0] === "find-generic-password").map((c) => String(c.args[4]));
    expect(lookups[0]).toMatch(/^profile:prod@[0-9a-f]{8}$/);
    expect(lookups[1]).toBe("profile:prod");
    expect([...items.keys()]).toEqual([lookups[0]]);
    expect(items.get(lookups[0])).toBe("live_legacy");
  });

  it("gives two different config dirs two different scoped accounts", async () => {
    const calls = stubSpawnSync(() => ok());
    await withConfigDir("/tmp/dir-one", () => macosSecurityStore().set("prod", "live_x"));
    await withConfigDir("/tmp/dir-two", () => macosSecurityStore().set("prod", "live_x"));
    const [first, second] = calls.map((c) => String(c.opts.input));
    expect(first).not.toBe(second);
  });
});

describe("platform keychain detection", () => {
  it("detects Windows PowerShell at its system path and handles its absence", () => {
    const originalPlatform = process.platform;
    const configDir = process.env.CHARGEBEE_CONFIG_DIR;
    const systemRoot = process.env.SystemRoot;
    const root = mkdtempSync(join(tmpdir(), "cb-windows-detect-"));
    Object.defineProperty(process, "platform", { value: "win32" });
    delete process.env.CHARGEBEE_CONFIG_DIR;
    try {
      delete process.env.SystemRoot;
      expect(keychainEnabled()).toBe(false);
      __resetKeychainForTest();
      process.env.SystemRoot = root;
      expect(keychainEnabled()).toBe(false);
      __resetKeychainForTest();
      const directory = join(root, "System32", "WindowsPowerShell", "v1.0");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "powershell.exe"), "test fixture");
      expect(keychainEnabled()).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      if (systemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = systemRoot;
      if (configDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
      else process.env.CHARGEBEE_CONFIG_DIR = configDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shells out to `which` at most once per process across many operations", async () => {
    const originalPlatform = process.platform;
    const previousConfigDir = process.env.CHARGEBEE_CONFIG_DIR;
    delete process.env.CHARGEBEE_CONFIG_DIR;
    Object.defineProperty(process, "platform", { value: "linux" });
    const calls = stubSpawnSync((call) =>
      call.cmd === "which" ? ok("/usr/bin/secret-tool") : ok(""),
    );
    try {
      keychainEnabled();
      keychainDisabledReason();
      await getProfileKey("a");
      await getProfileKey("b");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      if (previousConfigDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
      else process.env.CHARGEBEE_CONFIG_DIR = previousConfigDir;
    }
    expect(calls.filter((c) => c.cmd === "which")).toHaveLength(1);
  });
});

describe("credential deletion failures", () => {
  for (const [name, store, missing] of [
    ["macOS", () => macosSecurityStore(), 44],
    ["Linux", () => linuxSecretToolStore("/usr/bin/secret-tool"), 1],
  ] as const) {
    it(`${name} allows an absent credential but reports failures and timeouts`, async () => {
      stubSpawnSync(() => ({ ...ok(), status: missing }));
      await store().delete("prod");
      stubSpawnSync(() => ({ ...ok(), status: 1, stderr: "access denied" }));
      await expect(store().delete("prod")).rejects.toThrow(/deletion failed/);
      stubSpawnSync(() => timedOut());
      await expect(store().delete("prod")).rejects.toThrow(/timed out/);
    });
  }
});

describe("Windows Credential Manager", () => {
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

  it("transports secrets as data on stdin and preserves Unicode across reads", async () => {
    const secret = 'test_é\"$();secret';
    const encoded = Buffer.from(secret).toString("base64");
    const calls = stubSpawnSync((call) => JSON.parse(String(call.opts.input)).operation === "get" ? ok(JSON.stringify(encoded)) : ok());
    const store = windowsCredentialStore(powershell);
    await store.set("prod", secret);
    expect(await store.get("prod")).toBe(secret);
    await store.delete("prod");
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.cmd).toBe(powershell);
      expect(call.opts.timeout).toBe(30_000);
      expect(call.opts.windowsHide).toBe(true);
      expect(call.args.join(" ")).not.toContain(secret);
      expect(call.args.join(" ")).not.toContain(encoded);
      expect(call.args).toContain("-NoProfile");
      expect(call.args).toContain("-NonInteractive");
    }
    expect(JSON.parse(String(calls[0].opts.input))).toMatchObject({ operation: "set", account: "profile:prod", secret: encoded });
  });

  it("distinguishes missing credentials, backend errors, and malformed responses", async () => {
    const store = windowsCredentialStore(powershell);
    stubSpawnSync(() => ok("null"));
    expect(await store.get("prod")).toBeNull();
    stubSpawnSync(() => ok("{}"));
    await expect(store.get("prod")).rejects.toThrow(/Invalid response/);
    stubSpawnSync(() => ok("not json"));
    await expect(store.get("prod")).rejects.toThrow();
    stubSpawnSync(() => ({ ...ok(), status: 1, stderr: "sensitive context" }));
    for (const operation of [() => store.get("prod"), () => store.set("prod", "test_x"), () => store.delete("prod")]) {
      await expect(operation()).rejects.toThrow("Windows Credential Manager operation failed");
    }
    stubSpawnSync(() => timedOut());
    for (const operation of [() => store.get("prod"), () => store.set("prod", "test_x"), () => store.delete("prod")]) {
      await expect(operation()).rejects.toThrow("timed out after 30s waiting for the OS keychain");
    }
  });
});
