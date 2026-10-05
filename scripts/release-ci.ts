#!/usr/bin/env bun
// Publishing requires successful validation of the exact main commit.
import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { validationState, waitForValidation, VALIDATION_WORKFLOWS } from "../src/tools/release-ci-policy.js";

const repository = process.env.GITHUB_REPOSITORY ?? "";
// On push this is the exact main commit that the Release workflow would build.
// Never substitute latest main.
const sha = process.env.GITHUB_SHA ?? "";

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

try {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("GITHUB_REPOSITORY and GITHUB_SHA must identify the commit being validated.");
  }
  if (process.argv[2] === "wait") {
    // Only the read-only GitHub token is needed, with no dependency install or
    // npm/Chargebee credentials. API errors propagate and block publication.
    // Poll every 20 seconds; the workflow also imposes a 35-minute hard timeout.
    await waitForValidation(() => states(sha), () => setTimeout(20_000), console.log);
  } else {
    throw new Error("Usage: bun scripts/release-ci.ts wait");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Release validation failed");
  process.exitCode = 1;
}
