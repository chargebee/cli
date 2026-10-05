/**
 * OS credential store for Chargebee API keys (`test_` and `live_`).
 *
 * Keys go to the platform keychain when available (macOS `security`, Linux
 * `secret-tool`, Windows Credential Manager). File fallback (0600 JSON) if the store is missing or the
 * write fails.
 *
 * Disabled when `CHARGEBEE_CONFIG_DIR` is set (hermetic tests) unless
 * `CHARGEBEE_CLI_KEYCHAIN=1`. `CHARGEBEE_CLI_KEYCHAIN=0` forces the file store.
 */
import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { diagnostic } from "../output.js";
import { userHome } from "./user-home.js";
import { WINDOWS_CREDENTIAL_SCRIPT } from "./windows-credential-script.js";

export const KEYCHAIN_ENV = "CHARGEBEE_CLI_KEYCHAIN";

const SERVICE = "chargebee-cli";

/** Default subprocess deadline; a timeout makes the credential store unavailable. */
const SPAWN_TIMEOUT_MS = 10_000;
// Windows also starts PowerShell and compiles the Credential Manager interop bridge.
const WINDOWS_SPAWN_TIMEOUT_MS = 30_000;

type SpawnSyncFn = typeof nodeSpawnSync;
let spawnSyncImpl: SpawnSyncFn = nodeSpawnSync;

/** TEST-ONLY: replace `spawnSync` so keychain tests never shell out. */
export function __setSpawnSyncForTest(fn: SpawnSyncFn | null): void {
  spawnSyncImpl = fn ?? nodeSpawnSync;
}

/**
 * Throw a clear error for a killed/timed-out subprocess, or its raw spawn
 * error otherwise. No-op when the process ran (`r.error` unset).
 */
function throwIfSpawnFailed(r: SpawnSyncReturns<string>, timeoutMs = SPAWN_TIMEOUT_MS): void {
  if (!r.error) return;
  const err = r.error as NodeJS.ErrnoException;
  if (err.code === "ETIMEDOUT") {
    throw new Error(`timed out after ${timeoutMs / 1000}s waiting for the OS keychain`);
  }
  throw err;
}

export interface KeychainStore {
  /** Resolve `null` when no item exists; throw when the store cannot be read. */
  get(profile: string): Promise<string | null>;
  set(profile: string, secret: string): Promise<void>;
  delete(profile: string): Promise<void>;
}

/**
 * A profile declares `api_key_source: "keychain"` but the secret could not be
 * read (store locked/unreachable, item missing, or the keychain disabled by
 * env). Callers must surface `message` instead of treating the key as empty.
 */
export class KeychainUnavailableError extends Error {
  readonly profile: string;
  constructor(profile: string, message: string) {
    super(message);
    this.name = "KeychainUnavailableError";
    this.profile = profile;
  }
}

/** Build the user-facing message for a keychain-backed key that cannot be read. */
export function keychainUnavailableMessage(
  profile: string,
  reason: "error" | "missing" | "disabled",
  detail?: string,
): string {
  const head = `API key for profile "${profile}" is stored in the OS keychain but`;
  const trimmedDetail = detail?.trim().replace(/\.+$/, "");
  const why =
    reason === "error"
      ? `could not be read${trimmedDetail ? `: ${trimmedDetail}` : ""}.`
      : reason === "missing"
        ? "no such keychain item exists."
        : `the keychain is disabled here (${KEYCHAIN_ENV}=0 or CHARGEBEE_CONFIG_DIR is set, which uses the file store).`;
  const lines = [`${head} ${why}`, ""];
  if (reason === "error") {
    lines.push("  Check access to your OS credential store and retry (on Linux, check the login keyring and Secret Service session),");
    lines.push(`  or re-save the key: chargebee auth add --profile ${profile}`);
  } else if (reason === "missing") {
    lines.push(`  Re-save the key: chargebee auth add --profile ${profile}`);
  } else {
    lines.push(`  Unset ${KEYCHAIN_ENV} / CHARGEBEE_CONFIG_DIR, or re-save the key here: chargebee auth add --profile ${profile}`);
  }
  lines.push(
    `  To keep keys in the profile file instead, set ${KEYCHAIN_ENV}=0 before running auth add ` +
      "(CHARGEBEE_CONFIG_DIR also uses the file store).",
  );
  return lines.join("\n");
}

/** undefined = real platform; null = force off; object = injected store. */
let testStore: KeychainStore | null | undefined;

export function __setKeychainForTest(store: KeychainStore | null): void {
  testStore = store;
}

export function __resetKeychainForTest(): void {
  testStore = undefined;
  _platformKeychainCache = undefined;
}

/**
 * Suffix an account id with a short hash of the resolved config dir, but only
 * when it is not the default (`CHARGEBEE_CONFIG_DIR` unset, or spelling out
 * `~/.chargebee/cli`). This keeps today's account names for the common case
 * (so existing users' keychain items keep resolving) while letting two
 * different `CHARGEBEE_CONFIG_DIR`s share one login keychain without
 * overwriting or deleting each other's items. The path is resolved before
 * hashing so a trailing slash, `.` segment, or relative spelling of the same
 * directory maps to the same account.
 */
function configDirTag(): string {
  const dir = process.env.CHARGEBEE_CONFIG_DIR;
  if (!dir) return "";
  const resolved = resolve(dir);
  if (resolved === join(userHome(), ".chargebee", "cli")) return "";
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `@${hash}`;
}

function account(profile: string): string {
  return `profile:${profile}${configDirTag()}`;
}

/** The unscoped account name: what the default config dir uses, and what every config dir used before scoping. */
function unscopedAccount(profile: string): string {
  return `profile:${profile}`;
}

/**
 * True when the default config dir has a profile of this name, in which case
 * the unscoped keychain item may be that profile's key and a non-default
 * config dir must not delete it.
 */
function defaultDirHasProfile(profile: string): boolean {
  return existsSync(join(userHome(), ".chargebee", "cli", "profiles", `${profile}.json`));
}

/** A platform store keyed by the raw keychain account name; {@link scopedKeychainStore} maps profiles onto it. */
export interface KeychainAccountStore {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

/**
 * Map profile names onto scoped account names. For a non-default config dir a
 * read that misses the scoped account falls back to the unscoped item and, when
 * found, copies it under the scoped account so later reads hit directly. The
 * unscoped item is removed only once the scoped copy reads back and the default
 * config dir has no profile of that name (its key lives under the unscoped
 * account); the secret is returned either way. `delete` removes the scoped
 * item and, under the same ownership rule, the unscoped one.
 */
export function scopedKeychainStore(raw: KeychainAccountStore): KeychainStore {
  return {
    async get(profile) {
      const scoped = account(profile);
      const found = await raw.get(scoped);
      if (found !== null) return found;
      const unscoped = unscopedAccount(profile);
      if (unscoped === scoped) return null;
      const inherited = await raw.get(unscoped);
      if (inherited === null) return null;
      try {
        await raw.set(scoped, inherited);
        if ((await raw.get(scoped)) === inherited && !defaultDirHasProfile(profile)) await raw.delete(unscoped);
      } catch {
        // The item stays under the unscoped account and the next read tries again.
      }
      return inherited;
    },
    async set(profile, secret) {
      await raw.set(account(profile), secret);
    },
    async delete(profile) {
      const scoped = account(profile);
      await raw.delete(scoped);
      const unscoped = unscopedAccount(profile);
      if (unscoped !== scoped && !defaultDirHasProfile(profile)) await raw.delete(unscoped);
    },
  };
}

function envDisabled(): boolean {
  const v = (process.env[KEYCHAIN_ENV] ?? "").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off";
}

function envForcedOn(): boolean {
  const v = (process.env[KEYCHAIN_ENV] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

function which(bin: string): string | null {
  const r = spawnSyncImpl("which", [bin], { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS });
  if (r.status !== 0) return null;
  const p = r.stdout.trim();
  return p || null;
}

/** `undefined` = not detected yet; `null` = detected, no store on this platform. */
let _platformKeychainCache: KeychainStore | null | undefined;

function detectPlatformKeychain(): KeychainStore | null {
  if (process.platform === "darwin" && existsSync("/usr/bin/security")) {
    return macosSecurityStore();
  }
  if (process.platform === "linux") {
    const tool = which("secret-tool");
    if (tool) return linuxSecretToolStore(tool);
  }
  if (process.platform === "win32" && process.env.SystemRoot) {
    const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (existsSync(powershell)) return windowsCredentialStore(powershell);
  }
  return null;
}

/**
 * Detect and cache which OS keychain (if any) is available on this machine.
 * Detection shells out (`which secret-tool` on Linux); every caller in a
 * process — `keychainEnabled`, `keychainDisabledReason`, `activeStore` — goes
 * through this cache so a single command spawns it at most once no matter how
 * many profile operations it performs.
 */
export function platformKeychain(): KeychainStore | null {
  if (_platformKeychainCache === undefined) {
    _platformKeychainCache = detectPlatformKeychain();
  }
  return _platformKeychainCache;
}

/** Whether API keys should be written to / read from the OS store. */
export function keychainEnabled(): boolean {
  if (envDisabled()) return false;
  if (testStore === null) return false;
  if (testStore) return true;
  if (process.env.CHARGEBEE_CONFIG_DIR && !envForcedOn()) return false;
  return platformKeychain() !== null;
}

/**
 * Human-readable reason the OS keychain is not in use right now, or `null`
 * when it is available (mirrors {@link keychainEnabled}). Used to tell the
 * user why a key ended up in the profile file instead of the keychain.
 */
export function keychainDisabledReason(): string | null {
  if (envDisabled()) return `${KEYCHAIN_ENV}=0`;
  if (testStore === null) return "the keychain is disabled for this run";
  if (testStore) return null;
  if (process.env.CHARGEBEE_CONFIG_DIR && !envForcedOn()) return "CHARGEBEE_CONFIG_DIR is set";
  return platformKeychain() === null ? "no OS keychain was found on this system" : null;
}

function activeStore(): KeychainStore | null {
  if (!keychainEnabled()) return null;
  if (testStore) return testStore;
  return platformKeychain();
}

/**
 * Read a profile's key from the OS store. `null` means "no item" (or the store
 * is disabled — see `keychainEnabled()`); a store failure throws
 * {@link KeychainUnavailableError} so callers never mistake it for an empty key.
 */
export async function getProfileKey(profile: string): Promise<string | null> {
  const store = activeStore();
  if (!store) return null;
  try {
    return await store.get(profile);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new KeychainUnavailableError(profile, keychainUnavailableMessage(profile, "error", detail));
  }
}

export async function setProfileKey(profile: string, secret: string): Promise<boolean> {
  const store = activeStore();
  if (!store) return false;
  try {
    await store.set(profile, secret);
    return true;
  } catch {
    return false;
  }
}

export async function deleteProfileKey(profile: string, warnIfUnavailable = false): Promise<void> {
  const store = activeStore();
  if (!store) {
    if (warnIfUnavailable) diagnostic(`  ⚠ OS credential cleanup was skipped for profile "${profile}" because the store is unavailable or disabled; any previously stored API key may remain. Remove it from your OS credential manager.`);
    return;
  }
  try {
    await store.delete(profile);
  } catch {
    diagnostic(`  ⚠ Could not delete the OS credential for profile "${profile}"; its API key may remain. Remove the entry from your OS credential manager once access is restored.`);
  }
}

export function macosSecurityStore(): KeychainStore {
  return scopedKeychainStore({
    async get(acct) {
      const r = spawnSyncImpl(
        "/usr/bin/security",
        ["find-generic-password", "-s", SERVICE, "-a", acct, "-w"],
        { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS },
      );
      throwIfSpawnFailed(r);
      if (r.status !== 0) {
        // errSecItemNotFound (44) is "no key"; anything else (locked keychain,
        // "User interaction is not allowed", ACL denial) is a read failure.
        const stderr = (r.stderr ?? "").trim();
        if (r.status === 44 || /could not be found/i.test(stderr)) return null;
        throw new Error(stderr || `security exited with status ${r.status}`);
      }
      const secret = r.stdout.trim();
      return secret || null;
    },
    async set(acct, secret) {
      // `security -i` reads one command per line from stdin, so the secret is
      // never on argv (visible to `ps`) and never read through the terminal
      // prompt a bare `-w` uses when a controlling TTY exists. It is passed as
      // hex (`-X`), which needs no quoting; the quoted account name is checked
      // so it cannot break out of the command line.
      if (/["\\\x00-\x1f\x7f]/.test(acct)) {
        throw new Error(`keychain account "${acct}" contains a quote, backslash, or control character and cannot be stored in the macOS keychain`);
      }
      const hex = Buffer.from(secret, "utf8").toString("hex");
      const r = spawnSyncImpl("/usr/bin/security", ["-i"], {
        encoding: "utf8",
        input: `add-generic-password -U -s ${SERVICE} -a "${acct}" -X ${hex}\n`,
        timeout: SPAWN_TIMEOUT_MS,
      });
      throwIfSpawnFailed(r);
      if (r.status !== 0) {
        throw new Error(r.stderr.trim() || "macOS Keychain write failed");
      }
    },
    async delete(acct) {
      const r = spawnSyncImpl(
        "/usr/bin/security",
        ["delete-generic-password", "-s", SERVICE, "-a", acct],
        { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS },
      );
      throwIfSpawnFailed(r);
      if (r.status !== 0 && r.status !== 44) {
        throw new Error("macOS Keychain deletion failed");
      }
    },
  });
}

/** `resolvedTool` skips the `which` lookup when the caller already resolved the binary path. */
export function linuxSecretToolStore(resolvedTool?: string): KeychainStore {
  const tool = resolvedTool ?? which("secret-tool") ?? "secret-tool";
  return scopedKeychainStore({
    async get(acct) {
      const r = spawnSyncImpl(
        tool,
        ["lookup", "service", SERVICE, "account", acct],
        { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS },
      );
      throwIfSpawnFailed(r);
      if (r.status !== 0) {
        // `secret-tool lookup` exits 1 silently when nothing matches; a locked
        // or absent Secret Service prints the reason on stderr.
        const stderr = (r.stderr ?? "").trim();
        if (!stderr) return null;
        throw new Error(stderr);
      }
      const secret = r.stdout.trim();
      return secret || null;
    },
    async set(acct, secret) {
      // The secret goes to secret-tool on stdin, never on argv.
      const r = spawnSyncImpl(
        tool,
        ["store", "--label", `Chargebee CLI ${acct.replace(/^profile:/, "")}`, "service", SERVICE, "account", acct],
        { encoding: "utf8", input: secret, timeout: SPAWN_TIMEOUT_MS },
      );
      throwIfSpawnFailed(r);
      if (r.status !== 0) {
        throw new Error(r.stderr.trim() || "secret-tool write failed");
      }
    },
    async delete(acct) {
      const r = spawnSyncImpl(tool, ["clear", "service", SERVICE, "account", acct], {
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
      });
      throwIfSpawnFailed(r);
      if (r.status !== 0 && !(r.status === 1 && !r.stderr.trim())) {
        throw new Error("Secret Service credential deletion failed");
      }
    },
  });
}

/** Windows PowerShell calls the native Credential Manager APIs; no secret is placed in argv. */
export function windowsCredentialStore(powershell: string): KeychainStore {
  function run(operation: "get" | "set" | "delete", acct: string, secret?: string): string {
    const r = spawnSyncImpl(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(WINDOWS_CREDENTIAL_SCRIPT, "utf16le").toString("base64"),
    ], {
      encoding: "utf8", timeout: WINDOWS_SPAWN_TIMEOUT_MS, windowsHide: true,
      input: JSON.stringify({ operation, account: acct, secret: secret === undefined ? undefined : Buffer.from(secret, "utf8").toString("base64") }),
    });
    throwIfSpawnFailed(r, WINDOWS_SPAWN_TIMEOUT_MS);
    if (r.status !== 0) throw new Error("Windows Credential Manager operation failed");
    return r.stdout;
  }
  return scopedKeychainStore({
    async get(acct) {
      const value: unknown = JSON.parse(run("get", acct));
      if (value === null) return null;
      if (typeof value !== "string") throw new Error("Invalid response from Windows Credential Manager");
      return Buffer.from(value, "base64").toString("utf8");
    },
    async set(acct, secret) { run("set", acct, secret); },
    async delete(acct) { run("delete", acct); },
  });
}
