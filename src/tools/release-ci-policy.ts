import { isDeepStrictEqual } from "node:util";

// Both workflows must pass: CI covers source/artifacts; install smoke covers
// the delivery channels. Scope selection and the publishing gate share this list.
export const VALIDATION_WORKFLOWS = ["ci.yml", "install-smoke.yml"] as const;

export type ReleasePullRequest = {
  user?: { login?: string; type?: string };
  head?: { ref?: string; repo?: { full_name?: string } };
  base?: { ref?: string; sha?: string };
};

// Identity only makes a PR a candidate. Its diff and exact base validation must
// also qualify; a release-like branch name alone never permits skipping checks.
// Push events cannot qualify, so main always receives the full CI matrix.
export function isReleasePullRequest(eventName: string, pr: ReleasePullRequest | undefined, repository: string): boolean {
  return eventName === "pull_request" && pr?.user?.login === "github-actions[bot]" &&
    pr.user.type === "Bot" && pr.head?.repo?.full_name === repository &&
    pr.head.ref === "release-please--branches--main--components--cli" &&
    pr.base?.ref === "main" && /^[a-f0-9]{40}$/.test(pr.base.sha ?? "");
}

type ChangedFile = { path: string; status: string; oldMode: string; newMode: string };
type ReleaseMetadata = { package: string; manifest: string; changelog: string };

// Release Please currently emits beta versions. Any other shape takes full CI.
function betaVersion(version: unknown): number[] | undefined {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/.test(version)) return;
  const parts = version.replace("-beta.", ".").split(".").map(Number);
  if (parts.every(Number.isSafeInteger)) return parts;
}

export function isReleaseMetadataOnly(files: ChangedFile[], before: ReleaseMetadata, after: ReleaseMetadata): boolean {
  // Require modifications to the three existing regular files. Reject additions,
  // deletions, renames, symlinks, and executable-mode changes even on the bot PR.
  const allowed = ["package.json", ".release-please-manifest.json", "CHANGELOG.md"];
  if (files.length !== 3 || !allowed.every((path) => files.some((f) => f.path === path)) ||
    files.some((f) => f.status !== "M" || f.oldMode !== "100644" || f.newMode !== "100644")) return false;
  try {
    const oldPackage = JSON.parse(before.package);
    const newPackage = JSON.parse(after.package);
    const oldManifest = JSON.parse(before.manifest);
    const newManifest = JSON.parse(after.manifest);
    const oldVersion = betaVersion(oldPackage.version);
    const newVersion = betaVersion(newPackage.version);
    if (!oldVersion || !newVersion) return false;
    // Compare numeric components in precedence order (beta.10 is newer than
    // beta.9). Equal versions and rollbacks must take the full validation path.
    const firstDifference = newVersion.findIndex((part, i) => part !== oldVersion[i]);
    if (firstDifference < 0 || newVersion[firstDifference] <= oldVersion[firstDifference]) return false;
    if (oldManifest["."] !== oldPackage.version || newManifest["."] !== newPackage.version) return false;
    if (!after.changelog.split("\n").some((line) => line.startsWith(`## [${newPackage.version}]`))) return false;
    // Normalize only the allowed version fields before comparing whole objects.
    // Formatting/key order may differ; dependencies, scripts, and every other
    // package or manifest field must remain identical to the validated base.
    return isDeepStrictEqual({ ...oldPackage, version: newPackage.version }, newPackage) &&
      isDeepStrictEqual({ ...oldManifest, ".": newPackage.version }, newManifest);
  } catch {
    return false;
  }
}

export type WorkflowRun = {
  id: number;
  head_sha: string;
  head_branch: string;
  event: string;
  path: string;
  status: string;
  conclusion: string | null;
};

export function validationState(runs: WorkflowRun[], sha: string, workflow: string): "pending" | "success" | "failure" {
  // A green PR run or a different main commit cannot validate this release.
  // Inspect the newest matching run so an older success cannot hide a newer
  // failure or an unfinished rerun. GitHub updates the same run on reruns.
  const run = runs.filter((r) => r.head_sha === sha && r.head_branch === "main" &&
    r.event === "push" && r.path === `.github/workflows/${workflow}`)
    .sort((a, b) => b.id - a.id)[0];
  if (!run || run.status !== "completed") return "pending";
  // Cancelled, skipped, neutral, and timed-out runs do not authorize publishing.
  return run.conclusion === "success" ? "success" : "failure";
}

export async function waitForValidation(
  readStates: () => Array<{ workflow: string; state: ReturnType<typeof validationState> }>,
  sleep: () => Promise<void>,
  report: (message: string) => void,
  attempts = 90,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const results = readStates();
    report(results.map(({ workflow, state }) => `${workflow}: ${state}`).join(", "));
    if (results.some(({ state }) => state === "failure")) throw new Error("Main validation failed; release is blocked.");
    // readStates returns one result per required workflow. The length check
    // prevents an empty or partial response from passing through every().
    if (results.length === VALIDATION_WORKFLOWS.length && results.every(({ state }) => state === "success")) return;
    if (attempt < attempts) await sleep();
  }
  throw new Error("Timed out waiting for main validation; release is blocked.");
}
