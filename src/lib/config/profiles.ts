import { join } from "node:path";
import { diagnostic } from "../output.js";
import type { Region } from "./region.js";
import { configDir } from "./store.js";
import { writeFileAtomic } from "./atomic-write.js";
import {
  KeychainUnavailableError,
  deleteProfileKey,
  getProfileKey,
  keychainDisabledReason,
  keychainEnabled,
  keychainUnavailableMessage,
  setProfileKey,
} from "./keychain.js";

/**
 * Persisted profile shape. API targeting uses `host`. Stored as JSON at
 * `~/.chargebee/cli/profiles/<name>.json` with file mode 0o600.
 *
 * API keys (`test_` and `live_`) are stored in the OS keychain when available
 * (`api_key_source: "keychain"` and no key bytes on disk). File fallback keeps
 * them in `api_key`.
 */
export interface ProfileData {
  site: string;
  api_key: string;
  /** Product catalog version of the site, detected at configure time ("v1" | "v2"). */
  product_catalog_version?: string;
  /** Response schema type of the site ("plans_addons" | "items" | "compat"). */
  chargebee_response_schema_type?: string;
  /**
   * API host suffix without a leading dot.
   * Omitted for production (`chargebee.com`).
   */
  host?: string;
  /**
   * Chargebee region the site is hosted in (`us` | `eu` | `au`), used to reach
   * the regional webhook tunnel. Omitted for the default (`us`).
   */
  region?: Region;
  /**
   * Where the API key is stored: `"keychain"` when it lives in the OS keychain
   * (and is absent from this file), `"file"` when a keychain write was
   * attempted and failed so the key stays in `api_key`. Omitted for profiles
   * written where the keychain was never attempted (disabled by env, no OS
   * store, `CHARGEBEE_CONFIG_DIR`) or written by an older CLI version.
   */
  api_key_source?: "keychain" | "file";
}

/** Where a profile's API key ended up after `saveProfile`. */
export interface SaveProfileResult {
  backend: "keychain" | "file";
  /** Set when `backend` is `"file"`: why the OS keychain wasn't used. */
  reason?: string;
}

type DiskProfile = Omit<ProfileData, "api_key"> & { api_key?: string };

/**
 * A profile file exists but its JSON is not parseable (truncated write,
 * manual edit, disk corruption). Distinct from `ENOENT` (no file at all) so
 * callers can tell "never configured" from "configured but broken".
 */
export class CorruptProfileError extends Error {
  readonly profile: string;
  constructor(profile: string, path: string) {
    super(`Profile file ${path} is corrupt; re-run \`chargebee auth add --profile ${profile}\`.`);
    this.name = "CorruptProfileError";
    this.profile = profile;
  }
}

/** A profile name is one path segment: letters, digits, `.`, `_`, `-`, 1-64 chars, not starting with `.`/`_`/`-`. */
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Reserved device names on Windows — invalid as a file name there regardless of extension. */
const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

export function invalidProfileNameMessage(raw: string): string {
  return (
    `Invalid profile name "${raw}": use 1-64 characters of letters, digits, ".", "_", "-", ` +
    `starting with a letter or digit, and not a name reserved on Windows (CON, PRN, AUX, NUL, COM1-9, LPT1-9).`
  );
}

/**
 * Validate a profile name before it is used to build a file path or a
 * keychain account id. A name is exactly one path segment — no `/`, `\`,
 * leading `.`/`_`/`-` (which rules out `.` and `..`), quotes, or control
 * characters — and never a Windows-reserved device name, checked
 * case-insensitively and on the part before the first `.` (Windows treats
 * `CON.anything` as the device too) so the same profile can't collide across
 * platforms.
 */
export function assertValidProfileName(raw: string): string {
  const stem = raw.split(".", 1)[0].toUpperCase();
  if (!PROFILE_NAME_RE.test(raw) || WINDOWS_RESERVED_NAMES.has(stem)) {
    throw new Error(invalidProfileNameMessage(raw));
  }
  return raw;
}

/** Profiles live in `<configDir>/profiles/`. */
function profilesDir(): string {
  return join(configDir(), "profiles");
}

/** Absolute path to a profile's JSON file (exposed for status/warning output). */
export function profilePath(name: string): string {
  return join(profilesDir(), `${name}.json`);
}

/**
 * Save a profile to disk. The profile name is validated with
 * {@link assertValidProfileName} so writes stay inside the profiles dir.
 *
 * API keys are written to the OS keychain when enabled; the JSON then omits
 * key bytes. When the keychain is unavailable, the key stays in the file.
 * When the keychain cannot be read or written, a warning names the file where
 * the key was saved instead. The previous credential is retained until the
 * profile file is written, and restored if that write fails after replacement.
 */
export async function saveProfile(name: string, data: ProfileData): Promise<SaveProfileResult> {
  assertValidProfileName(name);
  if (!data.api_key) {
    throw new Error(`Refusing to save profile "${name}" without an API key.`);
  }
  const { mkdir } = await import("node:fs/promises");
  await mkdir(profilesDir(), { recursive: true, mode: 0o700 });

  const p = profilePath(name);
  const disk: DiskProfile = { ...data };
  let result: SaveProfileResult = { backend: "file" };
  const disabledReason = keychainDisabledReason();
  let previousKey: string | null = null;
  let keychainWriteSucceeded = false;
  if (disabledReason === null) {
    let needsKeySnapshot = false;
    try {
      const { readFile } = await import("node:fs/promises");
      const existing = JSON.parse(await readFile(p, "utf-8")) as DiskProfile;
      needsKeySnapshot = existing.api_key_source === "keychain";
    } catch (err) {
      if (err instanceof SyntaxError) {
        needsKeySnapshot = true; // A corrupt file may still have an OS credential.
      } else if (!(err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT")) {
        throw err;
      }
    }
    let keychainReadable = true;
    if (needsKeySnapshot) {
      try {
        previousKey = await getProfileKey(name);
      } catch {
        keychainReadable = false;
      }
    }
    if (keychainReadable) keychainWriteSucceeded = await setProfileKey(name, data.api_key);
    if (keychainWriteSucceeded) {
      delete disk.api_key;
      disk.api_key_source = "keychain";
      result = { backend: "keychain" };
    } else {
      disk.api_key_source = "file";
      result = {
        backend: "file",
        reason: keychainReadable ? "the OS keychain write failed" : "the OS keychain could not be read",
      };
    }
  } else {
    delete disk.api_key_source;
    result = { backend: "file", reason: disabledReason };
  }

  try {
    await writeFileAtomic(p, JSON.stringify(disk, null, 2));
  } catch (err) {
    if (previousKey !== null) {
      const currentKey = await getProfileKey(name).catch(() => null);
      if (currentKey !== previousKey && !(await setProfileKey(name, previousKey))) {
        throw new Error(
          `Could not save profile "${name}" or restore its previous OS credential. Re-run: chargebee auth add --profile ${name}`,
          { cause: err },
        );
      }
    } else if (keychainWriteSucceeded) {
      await deleteProfileKey(name);
    }
    throw err;
  }
  if (result.backend === "file") {
    await deleteProfileKey(name);
    if (disabledReason === null) {
      diagnostic(
        `  ⚠ Could not use the OS keychain; stored the API key in ${p} instead.\n` +
          `    Retry once the keychain is available: chargebee auth add --profile ${name}`,
      );
    }
  }
  return result;
}

/**
 * Load a profile by name. Returns `null` when the file doesn't exist (ENOENT only) —
 * other errors propagate so config corruption isn't silently swallowed.
 *
 * Hydrates `api_key` from the OS keychain when `api_key_source` is `keychain`.
 * A keychain-backed profile whose key cannot be read throws
 * {@link KeychainUnavailableError} — it never yields an empty `api_key`.
 */
export async function loadProfile(name: string): Promise<ProfileData | null> {
  assertValidProfileName(name);
  let content: string;
  try {
    const { readFile } = await import("node:fs/promises");
    content = await readFile(profilePath(name), "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  let raw: DiskProfile;
  try {
    raw = JSON.parse(content) as DiskProfile;
  } catch {
    throw new CorruptProfileError(name, profilePath(name));
  }
  if (raw.api_key_source !== "keychain") {
    return { ...raw, api_key: raw.api_key ?? "" };
  }
  const fromChain = await getProfileKey(name); // throws KeychainUnavailableError on store failure
  if (fromChain) return { ...raw, api_key: fromChain };
  if (raw.api_key) return { ...raw, api_key: raw.api_key };
  throw new KeychainUnavailableError(
    name,
    keychainUnavailableMessage(name, keychainEnabled() ? "missing" : "disabled"),
  );
}

/**
 * List every `*.json` profile in `profilesDir`, sorted alphabetically. Returns an
 * empty array if the directory doesn't exist (first-run / never-logged-in case).
 *
 * A keychain-backed profile whose key cannot be read is still listed, with an
 * empty `api_key` and `api_key_source: "keychain"`, so `auth list` can show
 * it as unavailable instead of hiding every profile. A file whose stem is not a
 * valid profile name, or whose JSON is corrupt, is skipped with a stderr warning
 * so the healthy profiles still show.
 */
export async function listProfiles(): Promise<{ name: string; data: ProfileData }[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(profilesDir());
    const profiles: { name: string; data: ProfileData }[] = [];
    for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
      const name = file.slice(0, -5);
      try {
        assertValidProfileName(name);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        diagnostic(
          `  ⚠ Skipping ${join(profilesDir(), file)}: ${why} ` +
            "Rename the file to <valid-name>.json to use it (if its key lives in the OS keychain, " +
            "re-run `chargebee auth add --profile <valid-name>` afterwards).",
        );
        continue;
      }
      try {
        const data = await loadProfile(name);
        if (data) profiles.push({ name, data });
      } catch (err) {
        if (err instanceof CorruptProfileError) {
          diagnostic(`  ⚠ Skipping corrupt profile file ${profilePath(name)}.`);
          continue;
        }
        if (!(err instanceof KeychainUnavailableError)) throw err;
        const { readFile } = await import("node:fs/promises");
        const raw = JSON.parse(await readFile(profilePath(name), "utf-8")) as DiskProfile;
        profiles.push({ name, data: { ...raw, api_key: "", api_key_source: "keychain" } });
      }
    }
    return profiles;
  } catch {
    return [];
  }
}

/**
 * Delete a named profile file. Returns true if a file was removed, false if it
 * was already absent. The name is validated (same guard as save/load).
 */
export async function deleteProfile(name: string): Promise<boolean> {
  assertValidProfileName(name);
  const { readFile, unlink } = await import("node:fs/promises");
  try {
    const content = await readFile(profilePath(name), "utf8");
    let mayHaveCredential: boolean;
    try {
      mayHaveCredential = JSON.parse(content).api_key_source === "keychain";
    } catch {
      // Allow corrupt profiles to be removed; a keychain entry may remain.
      mayHaveCredential = true;
    }
    await unlink(profilePath(name));
    await deleteProfileKey(name, mayHaveCredential);
    return true;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      await deleteProfileKey(name, true);
      return false;
    }
    throw err;
  }
}

/**
 * Rename a profile file. Refuses to overwrite an existing destination. The
 * caller is responsible for updating `activeProfile` in config when `oldName`
 * is the active profile.
 *
 * Order is read → write new → read new back → delete old, and the source is
 * never touched unless the destination holds a readable key. If the key cannot
 * be read (keychain locked/missing) this throws before anything is written.
 */
export async function renameProfile(oldName: string, newName: string): Promise<void> {
  assertValidProfileName(oldName);
  assertValidProfileName(newName);
  if (oldName === newName) return;
  const data = await loadProfile(oldName); // throws KeychainUnavailableError if unreadable
  if (!data) {
    throw new Error(`Profile "${oldName}" not found.`);
  }
  if (!data.api_key) {
    throw new Error(
      `Profile "${oldName}" has no API key; refusing to rename. Re-run: chargebee auth add --profile ${oldName}`,
    );
  }
  if (await profileFileExists(newName)) {
    throw new Error(`Profile "${newName}" already exists.`);
  }
  await saveProfile(newName, data);
  let copied: ProfileData | null = null;
  try {
    copied = await loadProfile(newName);
  } catch (err) {
    throw new Error(
      `Renamed copy "${newName}" could not be read back; "${oldName}" was left untouched. ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (copied?.api_key !== data.api_key) {
    throw new Error(
      `Renamed copy "${newName}" could not be read back with its API key; "${oldName}" was left untouched.`,
    );
  }
  await deleteProfile(oldName);
}

/**
 * Read a profile's non-secret fields straight off disk — never `api_key`, and
 * never the OS keychain, even for a keychain-backed profile. Callers that only
 * need `site`, `host`, or the cached catalog fields (telemetry, host
 * resolution) use this instead of {@link loadProfile} so they stay cheap.
 * Returns `null` when the profile file doesn't exist.
 */
export async function peekProfileMeta(
  name: string,
): Promise<Pick<ProfileData, "site" | "host" | "region" | "product_catalog_version" | "chargebee_response_schema_type"> | null> {
  assertValidProfileName(name);
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(profilePath(name), "utf-8")) as DiskProfile;
    return {
      site: raw.site,
      host: raw.host,
      region: raw.region,
      product_catalog_version: raw.product_catalog_version,
      chargebee_response_schema_type: raw.chargebee_response_schema_type,
    };
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function profileFileExists(name: string): Promise<boolean> {
  const { access } = await import("node:fs/promises");
  try {
    await access(profilePath(name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Bring credentials written by older CLI versions up to the current storage
 * model: every profile file that still holds an inline `api_key` is migrated
 * into the OS keychain, and legacy `oauth2/tokens/*.json` files are removed.
 * Runs only from `auth add` (never from ordinary commands) and does nothing
 * when the OS keychain is not in use.
 */
export async function migrateLegacyCredentials(): Promise<void> {
  if (keychainDisabledReason() !== null) return;
  let files: string[] = [];
  try {
    const { readdir } = await import("node:fs/promises");
    files = await readdir(profilesDir());
  } catch {
    /* no profiles yet */
  }
  for (const file of files.filter((f) => f.endsWith(".json")).sort()) {
    const name = file.slice(0, -5);
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = JSON.parse(await readFile(profilePath(name), "utf-8")) as DiskProfile;
      if (raw.api_key_source !== "keychain" && raw.api_key) await migrateInlineApiKey(name, raw.api_key);
    } catch {
      /* unreadable profile; loadProfile reports it when the profile is used */
    }
  }
  await cleanupLegacyOAuthTokens();
}

/**
 * Move a profile's inline plaintext key into the OS keychain and rewrite the
 * file without it. The key bytes are removed from the file only after the
 * keychain copy has been read back and compared equal; if the keychain write,
 * the read-back, or the file rewrite fails, the file is left untouched (and a
 * mismatching keychain item is removed) so the key stays recoverable from the
 * file. Returns whether the file was rewritten.
 */
async function migrateInlineApiKey(name: string, apiKey: string): Promise<boolean> {
  if (!(await setProfileKey(name, apiKey))) return false;
  let readBack: string | null = null;
  try {
    readBack = await getProfileKey(name);
  } catch {
    /* treated as a mismatch below */
  }
  if (readBack !== apiKey) {
    await deleteProfileKey(name);
    return false;
  }
  const p = profilePath(name);
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(p, "utf-8")) as DiskProfile;
    delete raw.api_key;
    raw.api_key_source = "keychain";
    await writeFileAtomic(p, JSON.stringify(raw, null, 2));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    diagnostic(`  Could not rewrite ${p} after copying its API key to the OS keychain; the key stays in the file (${detail}).`);
    return false;
  }
  diagnostic(`  Migrated the API key for profile "${name}" from the profile file into the OS keychain.`);
  return true;
}

/** Absolute path to the legacy (pre-profile) OAuth token directory. */
function legacyOAuthTokensDir(): string {
  return join(configDir(), "oauth2", "tokens");
}

/**
 * Remove legacy `oauth2/tokens/<site>.json` files written by CLI versions
 * before profile-based auth. Only files matching that shape (JSON with a
 * string `access_token` field) are removed; anything else in the directory is
 * left alone. Returns the file names removed.
 */
export async function cleanupLegacyOAuthTokens(): Promise<string[]> {
  const dir = legacyOAuthTokensDir();
  const removed: string[] = [];
  const { readdir, readFile, unlink, rmdir } = await import("node:fs/promises");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return removed;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const fp = join(dir, file);
    try {
      const parsed = JSON.parse(await readFile(fp, "utf-8")) as Record<string, unknown>;
      if (parsed && typeof parsed.access_token === "string") {
        await unlink(fp);
        removed.push(file);
      }
    } catch {
      /* not a file this CLI wrote; leave it alone */
    }
  }
  if (removed.length > 0) {
    diagnostic(`  Removed legacy plaintext credentials: ${removed.map((f) => join("oauth2", "tokens", f)).join(", ")}.`);
  }
  try {
    await rmdir(dir);
    await rmdir(join(configDir(), "oauth2"));
  } catch {
    /* not empty, or already gone */
  }
  return removed;
}
