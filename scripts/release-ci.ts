#!/usr/bin/env bun
// Two callers, with different failure policies:
//   scope: reduced checks are optional; uncertainty means full CI.
//   wait: publishing requires proof; uncertainty blocks the release.
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { isReleaseMetadataOnly, isReleasePullRequest, validationState, waitForValidation, VALIDATION_WORKFLOWS } from "../src/tools/release-ci-policy.js";

const repository = process.env.GITHUB_REPOSITORY ?? "";
// On pull_request this is the tested merge commit; on push it is the exact main
// commit that the Release workflow would build. Never substitute latest main.
const sha = process.env.GITHUB_SHA ?? "";
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", timeout: 30_000 });

function states(commit: string) {
  // Query workflow files rather than display names/check labels, which can be
  // shared by unrelated jobs. The policy rechecks SHA, branch, event, and path.
  return VALIDATION_WORKFLOWS.map((workflow) => {
    const response = execFileSync("gh", ["api",
      `repos/${repository}/actions/workflows/${workflow}/runs?event=push&branch=main&head_sha=${commit}&per_page=100`,
    ], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    return { workflow, state: validationState(JSON.parse(response).workflow_runs, commit, workflow) };
  });
}

function releaseOnly(): boolean {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
  if (!isReleasePullRequest(process.env.GITHUB_EVENT_NAME ?? "", event.pull_request, repository)) {
    console.log("Not a Release Please pull request.");
    return false;
  }
  const base = event.pull_request.base.sha;
  // Compare the tested merge commit directly with the exact base, so a stale
  // branch or unexpected merge content cannot hide source changes.
  // Raw output preserves file modes; disabling rename detection makes renames
  // appear as additions/deletions, which the metadata-only policy rejects.
  const raw = git("diff", "--raw", "--no-abbrev", "--no-renames", base, sha);
  const files = raw.trim().split("\n").filter(Boolean).map((line) => {
    const [metadata, path] = line.split("\t");
    const [oldMode, newMode, , , status] = metadata.slice(1).split(" ");
    return { path, status, oldMode, newMode };
  });
  const metadata = (ref: string) => ({
    package: git("show", `${ref}:package.json`),
    manifest: git("show", `${ref}:.release-please-manifest.json`),
    changelog: git("show", `${ref}:CHANGELOG.md`),
  });
  // Only consult previous runs after proving the source is unchanged. If the
  // base is still running or failed, rerun full checks instead of inheriting it.
  if (!isReleaseMetadataOnly(files, metadata(base), metadata(sha))) {
    console.log(`Changes are not a release metadata bump: ${files.map((f) => `${f.status} ${f.path}`).join(", ") || "none"}.`);
    return false;
  }
  const baseStates = states(base);
  if (!baseStates.every(({ state }) => state === "success")) {
    console.log(`Main validation of the base commit is not green: ${baseStates.map(({ workflow, state }) => `${workflow}: ${state}`).join(", ")}.`);
    return false;
  }
  return true;
}

try {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_SHA must identify the commit being validated.");
  }
  if (process.argv[2] === "scope") {
    let reduced = false;
    // Missing history, API access, or malformed metadata must never skip CI.
    try {
      reduced = releaseOnly();
    } catch (error) {
      console.log(`Could not verify release-only scope (${error instanceof Error ? error.message : String(error)}).`);
    }
    appendFileSync(process.env.GITHUB_OUTPUT!, `release_only=${reduced}\n`);
    console.log(reduced ? "Verified release metadata and successful base validation; using reduced PR checks." : "Using full CI.");
  } else if (process.argv[2] === "wait") {
    // Only the read-only GitHub token is needed, with no dependency install or
    // npm/Chargebee credentials. API errors propagate and block publication.
    // Poll every 20 seconds; the workflow also imposes a 35-minute hard timeout.
    await waitForValidation(() => states(sha), () => setTimeout(20_000), console.log);
  } else {
    throw new Error("Usage: bun scripts/release-ci.ts <scope|wait>");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Release validation failed");
  process.exitCode = 1;
}
