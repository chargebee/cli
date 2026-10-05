import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { humanLog, diagnostic, exitCommand, jsonResult, isJsonMode } from "../output.js";
import { configDir } from "../config/store.js";
import { isCompiledBinary as processIsCompiledBinary } from "../runtime.js";

const REPO = "chargebee/cli";
const NPM_PACKAGE = "@chargebee/cli";
const INSTALL_SH_URL = `https://raw.githubusercontent.com/${REPO}/main/install.sh`;
const INSTALL_METHOD_FILE = "install-method";

/** Bound every network/subprocess call on the update path so a stalled connection or wrapper never hangs it forever. */
const METADATA_FETCH_TIMEOUT_MS = 10_000;
const ASSET_DOWNLOAD_TIMEOUT_MS = 120_000;
const GH_TOKEN_TIMEOUT_MS = 5_000;
const NPM_INSTALL_TIMEOUT_MS = 300_000;
/** Bound on `<installed binary> --version`, the post-update sanity probe. */
const VERSION_PROBE_TIMEOUT_MS = 10_000;

export type InstallMethod = "github" | "npm" | "pnpm" | "yarn" | "bun-global" | "source";
export type PublicInstallMethod = "github" | "npm";
/** A global install method that is not plain npm, so `npm install -g` would create a duplicate instead of updating it. */
export type OtherPackageManager = "pnpm" | "yarn" | "bun-global";
export type UpdateChannel = "stable" | "beta";

/** The release the version check chose. `tag` is the exact GitHub tag the assets live under. */
export type LatestRelease = {
  version: string;
  tag: string;
  /** API asset URLs by asset name (works for private repos too; browser URLs do not). */
  assets: Record<string, string>;
};

type SpawnSyncFn = typeof spawnSync;
type FsOps = Pick<
  typeof fs,
  "realpathSync" | "writeFileSync" | "chmodSync" | "renameSync" | "rmSync" | "unlinkSync"
>;

let spawnSyncImpl: SpawnSyncFn = spawnSync;
let fsImpl: FsOps = fs;
let compiledBinaryOverride: boolean | null = null;
let installMethodOverride: InstallMethod | null = null;
let platformOverride: NodeJS.Platform | null = null;
let execPathOverride: string | null = null;
let timeoutOverrides: {
  metadata?: number;
  asset?: number;
  ghToken?: number;
  npmInstall?: number;
} = {};

/** TEST-ONLY: shrink the update path's timeouts so a hang test does not wait for real seconds. Pass null to restore. */
export function __setUpdateTimeoutsForTest(overrides: typeof timeoutOverrides | null): void {
  timeoutOverrides = overrides ?? {};
}

function metadataTimeoutMs(): number {
  return timeoutOverrides.metadata ?? METADATA_FETCH_TIMEOUT_MS;
}
function assetTimeoutMs(): number {
  return timeoutOverrides.asset ?? ASSET_DOWNLOAD_TIMEOUT_MS;
}
function ghTokenTimeoutMs(): number {
  return timeoutOverrides.ghToken ?? GH_TOKEN_TIMEOUT_MS;
}
function npmInstallTimeoutMs(): number {
  return timeoutOverrides.npmInstall ?? NPM_INSTALL_TIMEOUT_MS;
}

/** True for a fetch aborted by `AbortSignal.timeout()` or a spawnSync that hit its `timeout` option. */
function isTimeoutError(err: unknown): boolean {
  if (!err) return false;
  if ((err as { name?: string }).name === "TimeoutError") return true;
  return (err as { code?: string }).code === "ETIMEDOUT";
}

/** TEST-ONLY: replace spawnSync so update tests never hit the network or npm. */
export function __setSpawnSyncForTest(fn: SpawnSyncFn | null): void {
  spawnSyncImpl = fn ?? spawnSync;
}

/** TEST-ONLY: replace the fs calls used to swap the binary (Windows sequence has no real host in CI). */
export function __setFsForTest(ops: Partial<FsOps> | null): void {
  fsImpl = ops ? { ...fs, ...ops } : fs;
}

/** TEST-ONLY: force the compiled-binary heuristic. Pass null to restore. */
export function __setCompiledBinaryForTest(value: boolean | null): void {
  compiledBinaryOverride = value;
}

/** TEST-ONLY: force install-method detection. Pass null to restore. */
export function __setInstallMethodForTest(value: InstallMethod | null): void {
  installMethodOverride = value;
}

/** TEST-ONLY: pretend to run on another platform. Pass null to restore. */
export function __setPlatformForTest(value: NodeJS.Platform | null): void {
  platformOverride = value;
}

/** TEST-ONLY: pretend the running binary lives elsewhere. Pass null to restore. */
export function __setExecPathForTest(value: string | null): void {
  execPathOverride = value;
}

function platform(): NodeJS.Platform {
  return platformOverride ?? process.platform;
}

function execPath(): string {
  return execPathOverride ?? process.execPath;
}

export function normalizeVersion(v: string): string {
  // Only a `v` directly in front of a digit is a tag prefix; "vnext" or "main" stay as they are.
  return v.trim().replace(/^v(?=\d)/, "").split(/\s+/)[0] ?? "";
}

function isPrereleaseVersion(version: string): boolean {
  return version.includes("-");
}

export function resolveGithubToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const gh = spawnSyncImpl("gh", ["auth", "token"], { encoding: "utf8", timeout: ghTokenTimeoutMs() });
  if (isTimeoutError(gh.error)) {
    diagnostic(`  gh auth token timed out after ${ghTokenTimeoutMs() / 1000}s; continuing without a token.`);
    return null;
  }
  if (gh.status === 0 && gh.stdout?.trim()) return gh.stdout.trim();
  return null;
}

export function npmDistTag(version: string): "beta" | "latest" {
  return isPrereleaseVersion(version) ? "beta" : "latest";
}

/**
 * Which releases `update` may move to. `--channel` wins, then
 * `CHARGEBEE_CLI_CHANNEL`, else `beta` only while this copy is a prerelease
 * (so beta testers keep getting betas and land on GA once it is newest, while
 * stable users never get moved onto a prerelease). Null = invalid value.
 */
export function resolveUpdateChannel(
  flag: string | undefined,
  env: string | undefined,
  currentVersion: string,
): UpdateChannel | null {
  const raw = (flag ?? env ?? "").trim().toLowerCase();
  if (raw === "") return isPrereleaseVersion(currentVersion) ? "beta" : "stable";
  if (raw === "stable" || raw === "beta") return raw;
  return null;
}

type GithubAsset = { name?: string; url?: string };
type GithubRelease = { tag_name?: string; draft?: boolean; prerelease?: boolean; assets?: GithubAsset[] };

function githubHeaders(accept: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept };
  const token = resolveGithubToken();
  if (token) headers.Authorization = `token ${token}`;
  return headers;
}

/** Stable uses GitHub's latest release; beta includes prereleases and promotion to stable. */
export async function fetchLatestRelease(channel: UpdateChannel = "stable"): Promise<LatestRelease | null> {
  try {
    const endpoint = channel === "stable" ? "releases/latest" : "releases?per_page=10";
    const res = await fetch(`https://api.github.com/repos/${REPO}/${endpoint}`, {
      headers: githubHeaders("application/vnd.github+json"),
      signal: AbortSignal.timeout(metadataTimeoutMs()),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as GithubRelease | GithubRelease[];
    const releases = Array.isArray(data) ? data : [data];
    const latest = releases.find((r) => {
      if (!r?.tag_name || r.draft) return false;
      if (channel === "beta") return true;
      // release-please does not always flag betas as GitHub prereleases; trust the tag too.
      return !r.prerelease && !isPrereleaseVersion(normalizeVersion(r.tag_name));
    });
    if (!latest?.tag_name) return null;
    const assets: Record<string, string> = {};
    for (const a of latest.assets ?? []) {
      if (a?.name && a.url) assets[a.name] = a.url;
    }
    return { version: normalizeVersion(latest.tag_name), tag: latest.tag_name, assets };
  } catch (err) {
    if (isTimeoutError(err)) {
      diagnostic(`  Update check timed out after ${metadataTimeoutMs() / 1000}s.`);
    }
    return null;
  }
}

export async function fetchLatestVersion(channel: UpdateChannel = "stable"): Promise<string | null> {
  return (await fetchLatestRelease(channel))?.version ?? null;
}

/** Path separators normalized to `/`, lowercased, for path-shape heuristics. */
function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** File names of JavaScript runtimes; a self-update must never write the CLI asset over one of these. */
const RUNTIME_EXECUTABLE = /^(node|nodejs|node\d+|bun|bunx|deno)(\.exe)?$/i;

/** True when `path`'s file name is a JavaScript runtime rather than the CLI binary. Path-separator agnostic. */
function isRuntimeExecutable(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return RUNTIME_EXECUTABLE.test(normalized.slice(normalized.lastIndexOf("/") + 1));
}

/**
 * True when running from a compiled standalone binary (`execPath` is the binary).
 * Fallback only — prefer the install-method marker written at install time.
 * Decided from the launch shape (Bun's virtual entry, or no entry script that
 * resolves on disk), never from the runtime's file name, so a renamed or
 * versioned runtime (`nodejs`, `node22`, an nvm shim) running the CLI script
 * is not mistaken for the compiled binary.
 */
export function isCompiledBinary(): boolean {
  if (compiledBinaryOverride !== null) return compiledBinaryOverride;
  return processIsCompiledBinary({ execPath: execPath(), argv: process.argv });
}

export function persistInstallMethod(method: PublicInstallMethod): void {
  try {
    const dir = configDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, INSTALL_METHOD_FILE), `${method}\n`, { encoding: "utf8" });
  } catch {
    // Marker is a hint for the next update; a failed write must not fail the install.
  }
}

export function readInstallMethod(): PublicInstallMethod | null {
  try {
    const raw = readFileSync(join(configDir(), INSTALL_METHOD_FILE), "utf8").trim();
    if (raw === "github" || raw === "npm") return raw;
    return null;
  } catch {
    return null;
  }
}

/** `entry` resolves through some package manager's `node_modules/@chargebee/cli`. Path-separator agnostic. */
function isNpmPackageEntry(entry: string): boolean {
  const normalized = normalizePathForMatch(entry);
  if (!normalized.includes("node_modules")) return false;
  return normalized.includes(NPM_PACKAGE.toLowerCase());
}

/** pnpm's global store nests packages under a `pnpm` directory even when the resolved path also says `node_modules`. */
function isPnpmGlobalEntry(entry: string): boolean {
  return normalizePathForMatch(entry).includes("/pnpm/");
}

/** Yarn's global install directory (classic `~/.config/yarn/global`, or `%LOCALAPPDATA%\Yarn`). */
function isYarnGlobalEntry(entry: string): boolean {
  return normalizePathForMatch(entry).includes("/yarn/");
}

/** bun's global install store: `~/.bun/install/global/node_modules/...`. */
function isBunGlobalEntry(entry: string): boolean {
  return normalizePathForMatch(entry).includes("/.bun/");
}

/**
 * Marker first, then compiled-binary heuristic, then the shape of the
 * resolved entry path. pnpm/yarn/bun global installs still nest under
 * `node_modules`, so they are checked before falling back to plain "npm" —
 * `npm install -g` would otherwise create a duplicate install alongside them.
 * Never guess npm (or another manager) for a git checkout.
 */
export function detectInstallMethod(): InstallMethod {
  if (installMethodOverride !== null) return installMethodOverride;
  const marked = readInstallMethod();
  if (marked) return marked;
  if (isCompiledBinary()) return "github";
  const entry = process.argv[1] ?? "";
  if (!isNpmPackageEntry(entry)) return "source";
  if (isPnpmGlobalEntry(entry)) return "pnpm";
  if (isYarnGlobalEntry(entry)) return "yarn";
  if (isBunGlobalEntry(entry)) return "bun-global";
  return "npm";
}

const OTHER_PACKAGE_MANAGER_COMMAND: Record<OtherPackageManager, (spec: string) => string> = {
  pnpm: (spec) => `pnpm add -g ${spec}`,
  yarn: (spec) => `yarn global add ${spec}`,
  "bun-global": (spec) => `bun add -g ${spec}`,
};

const OTHER_PACKAGE_MANAGER_NAME: Record<OtherPackageManager, string> = {
  pnpm: "pnpm",
  yarn: "yarn",
  "bun-global": "bun",
};

/** Message for a global install through pnpm/yarn/bun: never run `npm install -g` against it. */
export function otherPackageManagerUpdateMessage(
  method: OtherPackageManager,
  latestVersion: string | null,
  channel: UpdateChannel,
): string {
  const tag = latestVersion ? npmDistTag(latestVersion) : channel === "beta" ? "beta" : "latest";
  const spec = `${NPM_PACKAGE}@${tag}`;
  return (
    `\n  This copy was installed with ${OTHER_PACKAGE_MANAGER_NAME[method]}, not npm.\n` +
    `  Run: ${OTHER_PACKAGE_MANAGER_COMMAND[method](spec)}`
  );
}

/**
 * `.cmd` shims (npm, the npm-installed `chargebee`) need a shell on Windows;
 * Node refuses to spawn them directly. Only ever called with a constant argv.
 */
function spawnShim(name: string, args: string[], opts: Parameters<SpawnSyncFn>[2]) {
  const win = platform() === "win32";
  return spawnSyncImpl(win ? `${name}.cmd` : name, args, { ...opts, shell: win });
}

function reportUpdated(currentVersion: string, probe: () => ReturnType<SpawnSyncFn>, fallback: string): void {
  let newVersion = fallback;
  try {
    const result = probe();
    const out = result.stdout?.toString().trim();
    if (!result.error && result.status === 0 && out) newVersion = normalizeVersion(out);
  } catch {
    // Reporting is best-effort; the update itself already succeeded.
  }
  jsonResult({ updated: true, previous_version: currentVersion, version: newVersion });
  humanLog(`  Updated: ${currentVersion} → ${newVersion}`);
}

/** Release asset name, identical to install.sh / install.ps1. */
export function githubAssetName(os: NodeJS.Platform = platform(), arch: NodeJS.Architecture = process.arch): string {
  if (os === "win32") return "chargebee-cli-windows-x64.exe";
  return `chargebee-cli-${os}-${arch}`;
}

async function downloadAsset(url: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: githubHeaders("application/octet-stream"),
      redirect: "follow",
      signal: AbortSignal.timeout(assetTimeoutMs()),
    });
  } catch (err) {
    if (isTimeoutError(err)) throw new Error(`timed out after ${assetTimeoutMs() / 1000}s`);
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** True when CHARGEBEE_CLI_SKIP_CHECKSUM opts out of the checksum verification below. */
function skipChecksumVerification(): boolean {
  const v = (process.env.CHARGEBEE_CLI_SKIP_CHECKSUM ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no";
}

/** SHA-256 for `assetName` from a `SHA256SUMS.txt` body, or null if absent. */
export function parseSha256Sums(sums: string, assetName: string): string | null {
  for (const line of sums.split("\n")) {
    const [hash, ...rest] = line.trim().split(/\s+/);
    if (!hash || rest.length === 0) continue;
    if (rest.join(" ").replace(/^\*/, "") === assetName) return hash.toLowerCase();
  }
  return null;
}

/**
 * Fetch `SHA256SUMS.txt` from the same release and abort the update if it is
 * missing or does not match `bytes`. No-op (with a warning) when
 * CHARGEBEE_CLI_SKIP_CHECKSUM opts out.
 */
async function verifyChecksum(release: LatestRelease, asset: string, bytes: Buffer): Promise<void> {
  if (skipChecksumVerification()) {
    diagnostic("  Warning: skipping checksum verification (CHARGEBEE_CLI_SKIP_CHECKSUM=1)");
    return;
  }

  const sumsUrl = release.assets["SHA256SUMS.txt"] ?? `https://github.com/${REPO}/releases/download/${release.tag}/SHA256SUMS.txt`;
  let sumsText: string;
  try {
    const res = await fetch(sumsUrl, {
      headers: githubHeaders("application/octet-stream"),
      redirect: "follow",
      signal: AbortSignal.timeout(metadataTimeoutMs()),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sumsText = await res.text();
  } catch (err) {
    if (isTimeoutError(err)) {
      diagnostic(`\n  Update failed — downloading SHA256SUMS.txt for ${release.tag} timed out after ${metadataTimeoutMs() / 1000}s.`);
    } else {
      diagnostic(`\n  Update failed — could not download SHA256SUMS.txt for ${release.tag}.`);
    }
    diagnostic("  Set CHARGEBEE_CLI_SKIP_CHECKSUM=1 to skip verification (not recommended).");
    exitCommand(1);
  }

  const expected = parseSha256Sums(sumsText, asset);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!expected || actual !== expected) {
    diagnostic(`\n  Update failed — checksum verification failed for ${asset}.`);
    diagnostic("  Set CHARGEBEE_CLI_SKIP_CHECKSUM=1 to skip verification (not recommended).");
    exitCommand(1);
  }
}

function isPermissionError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

/**
 * Swap `${target}.new` into place. Unix: one atomic rename. Windows: a running
 * exe cannot be overwritten but can be renamed, so park it as `.old` (removed
 * by `cleanupStaleBinary()` on the next start) and roll back if the swap fails.
 */
function swapBinary(target: string, fresh: string): void {
  if (platform() !== "win32") {
    fsImpl.renameSync(fresh, target);
    return;
  }
  const old = `${target}.old`;
  fsImpl.rmSync(old, { force: true });
  fsImpl.renameSync(target, old);
  try {
    fsImpl.renameSync(fresh, target);
  } catch (err) {
    fsImpl.renameSync(old, target);
    throw err;
  }
}

/** Remove the `.old` exe left behind by a Windows self-update. Best-effort, win32 only. */
export function cleanupStaleBinary(): void {
  if (platform() !== "win32" || !isCompiledBinary()) return;
  try {
    fsImpl.unlinkSync(`${execPath()}.old`);
  } catch {
    // Not there, or still held by another instance; try again next start.
  }
}

function printInstallerFallback(binDir: string, tag: string): void {
  diagnostic("  Re-run the installer with the right permissions instead:");
  diagnostic(
    `    curl -fsSL ${INSTALL_SH_URL} | sudo env CHARGEBEE_CLI_BIN_DIR=${binDir} CHARGEBEE_CLI_VERSION=${tag} CHARGEBEE_CLI_NO_ONBOARDING=1 bash`,
  );
}

/**
 * Replace the running binary with the release asset for the exact tag the
 * version check chose. No installer script is executed, the install dir is
 * kept, nothing prompts, and the token only ever travels in a request header.
 */
export async function updateGithub(currentVersion: string, release: LatestRelease | null): Promise<void> {
  const win = platform() === "win32";
  if (win && !isCompiledBinary()) {
    diagnostic("\n  Update failed — Windows GitHub updates replace the compiled .exe.");
    diagnostic("  Download chargebee-cli-windows-x64.exe from GitHub Releases.");
    exitCommand(1);
  }
  if (!release) {
    diagnostic("\n  Update failed — could not determine the latest release, so there is no tag to download.");
    diagnostic(win ? "  Re-run install.ps1 once you are online." : `  Re-run: curl -fsSL ${INSTALL_SH_URL} | bash`);
    exitCommand(1);
  }

  const asset = githubAssetName();
  const url = release.assets[asset] ?? `https://github.com/${REPO}/releases/download/${release.tag}/${asset}`;
  let target: string;
  try {
    target = fsImpl.realpathSync(execPath());
  } catch {
    target = execPath();
  }
  if (isRuntimeExecutable(target)) {
    diagnostic(`\n  Update failed — ${target} is a JavaScript runtime, not the Chargebee CLI binary, so it will not be replaced.`);
    diagnostic(
      win
        ? "  Update the package that installed the CLI instead, or re-run install.ps1."
        : `  Update the package that installed the CLI instead, or re-run: curl -fsSL ${INSTALL_SH_URL} | bash`,
    );
    exitCommand(1);
  }
  const fresh = `${target}.new`;

  humanLog("  Updating via GitHub Releases...");
  let bytes: Buffer;
  try {
    bytes = await downloadAsset(url);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("HTTP ")) {
      diagnostic(`\n  Update failed — could not download ${asset} (${err.message}).`);
      diagnostic(`  See https://github.com/${REPO}/releases`);
    } else {
      diagnostic(`\n  Update failed — could not download ${asset}.`);
      if (err instanceof Error) diagnostic(`  ${err.message}`);
    }
    exitCommand(1);
  }

  await verifyChecksum(release, asset, bytes);

  try {
    fsImpl.writeFileSync(fresh, bytes);
    if (!win) fsImpl.chmodSync(fresh, 0o755);
  } catch (err) {
    fsImpl.rmSync(fresh, { force: true });
    if (!win && isPermissionError(err)) {
      diagnostic(`\n  Update failed — ${dirname(target)} is not writable by this user.`);
      printInstallerFallback(dirname(target), release.tag);
    } else {
      diagnostic(`\n  Update failed — could not write ${fresh}.`);
      if (err instanceof Error) diagnostic(`  ${err.message}`);
    }
    exitCommand(1);
  }
  try {
    swapBinary(target, fresh);
  } catch (err) {
    fsImpl.rmSync(fresh, { force: true });
    diagnostic(`\n  Update downloaded but could not replace ${target}.`);
    if (err instanceof Error) diagnostic(`  ${err.message}`);
    if (!win && isPermissionError(err)) printInstallerFallback(dirname(target), release.tag);
    exitCommand(1);
  }

  persistInstallMethod("github");
  reportUpdated(
    currentVersion,
    () => spawnSyncImpl(target, ["--version"], { encoding: "utf8", timeout: VERSION_PROBE_TIMEOUT_MS }),
    release.version,
  );
}

/** Reinstall through npm, following the dist-tag of the release the check chose. */
export function updateNpm(
  currentVersion: string,
  latestVersion: string | null,
  channel: UpdateChannel,
): void {
  const tag = latestVersion ? npmDistTag(latestVersion) : channel === "beta" ? "beta" : "latest";
  const spec = `${NPM_PACKAGE}@${tag}`;
  humanLog("  Updating via npm...");
  const result = spawnShim("npm", ["install", "-g", spec], { stdio: isJsonMode() ? "pipe" : "inherit", timeout: npmInstallTimeoutMs() });
  if (result.error || result.status !== 0) {
    if (isTimeoutError(result.error)) {
      diagnostic(`\n  Update failed — npm install timed out after ${npmInstallTimeoutMs() / 1000}s.`);
    } else if (result.error) {
      diagnostic(`\n  Update failed — could not run npm: ${result.error.message}`);
    } else {
      diagnostic(`\n  Update failed — npm exited with code ${result.status}.`);
    }
    diagnostic(`  Run: npm install -g ${spec}`);
    exitCommand(1);
  }
  persistInstallMethod("npm");
  reportUpdated(
    currentVersion,
    () => spawnShim("chargebee", ["--version"], { encoding: "utf8", timeout: VERSION_PROBE_TIMEOUT_MS }),
    latestVersion ?? "done",
  );
}
