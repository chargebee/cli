import { describe, expect, test } from "bun:test";
import { isReleaseMetadataOnly, isReleasePullRequest, validationState, waitForValidation, type WorkflowRun } from "../../../tools/release-ci-policy.js";

const sha = "a".repeat(40);
const pr = {
  user: { login: "github-actions[bot]", type: "Bot" },
  head: { ref: "release-please--branches--main--components--cli", repo: { full_name: "example/cli" } },
  base: { ref: "main", sha },
};

describe("release PR eligibility", () => {
  test("accepts the same-repository release bot PR", () => {
    expect(isReleasePullRequest("pull_request", pr, "example/cli")).toBe(true);
  });
  test("never reduces main pushes, manual events or missing PRs", () => {
    for (const event of ["push", "workflow_dispatch", "pull_request_target"]) {
      expect(isReleasePullRequest(event, pr, "example/cli")).toBe(false);
    }
    expect(isReleasePullRequest("pull_request", undefined, "example/cli")).toBe(false);
  });
  test("rejects a human author, fork, wrong branch/base, or invalid base SHA", () => {
    const candidates = [
      { ...pr, user: { login: "contributor", type: "User" } },
      { ...pr, user: { login: "github-actions[bot]", type: "User" } },
      { ...pr, head: { ...pr.head, repo: { full_name: "fork/cli" } } },
      { ...pr, head: { ...pr.head, ref: "feature" } },
      { ...pr, base: { ...pr.base, ref: "dev" } },
      { ...pr, base: { ...pr.base, sha: "main" } },
    ];
    for (const candidate of candidates) expect(isReleasePullRequest("pull_request", candidate, "example/cli")).toBe(false);
  });
});

const files = ["package.json", ".release-please-manifest.json", "CHANGELOG.md"]
  .map((path) => ({ path, status: "M", oldMode: "100644", newMode: "100644" }));
function metadata(version: unknown = "1.4.0-beta.4") {
  return {
    package: JSON.stringify({ name: "@example/cli", version, scripts: { build: "bun build" }, dependencies: { example: "1.0.0" } }),
    manifest: JSON.stringify({ ".": version }),
    changelog: `# Changelog\n\n## [${version}](https://example.com)\n\nFixes.\n`,
  };
}
const before = metadata();
const after = metadata("1.4.0-beta.5");

describe("release-only diff", () => {
  test("accepts an increasing beta version with matching manifest and changelog", () => {
    expect(isReleaseMetadataOnly(files, before, after)).toBe(true);
    expect(isReleaseMetadataOnly(files, before, metadata("1.5.0-beta.1"))).toBe(true);
  });
  test("rejects source, workflow, lockfile or any other additional edit", () => {
    for (const path of ["src/index.ts", "bun.lock", ".github/workflows/ci.yml", "README.md"]) {
      expect(isReleaseMetadataOnly([...files, { ...files[0], path }], before, after)).toBe(false);
    }
  });
  test("rejects incomplete, duplicated, renamed, deleted or mode-only files", () => {
    expect(isReleaseMetadataOnly(files.slice(1), before, after)).toBe(false);
    expect(isReleaseMetadataOnly([files[0], files[0], files[2]], before, after)).toBe(false);
    for (const change of [{ status: "A" }, { status: "D" }, { status: "R100" }, { newMode: "100755" }, { oldMode: "120000" }]) {
      expect(isReleaseMetadataOnly([{ ...files[0], ...change }, ...files.slice(1)], before, after)).toBe(false);
    }
  });
  test("rejects package edits beyond version, even on a release bot branch", () => {
    for (const change of [{ scripts: { build: "another command" } }, { dependencies: {} }, { name: "another-name" }, { engines: { node: ">=24" } }]) {
      const pkg = { ...JSON.parse(after.package), ...change };
      expect(isReleaseMetadataOnly(files, before, { ...after, package: JSON.stringify(pkg) })).toBe(false);
    }
  });
  test("ignores JSON formatting and key order", () => {
    const pkg = JSON.parse(after.package);
    const reordered = { dependencies: pkg.dependencies, version: pkg.version, scripts: pkg.scripts, name: pkg.name };
    expect(isReleaseMetadataOnly(files, before, { ...after, package: JSON.stringify(reordered, null, 2) })).toBe(true);
  });
  test("rejects unchanged, lower, malformed, stable or unsafe numeric versions", () => {
    for (const version of ["1.4.0-beta.4", "1.3.0-beta.9", "1.4.0", "1.4.0-beta.05", "999999999999999999999.0.0-beta.1", 5, null]) {
      expect(isReleaseMetadataOnly(files, before, metadata(version))).toBe(false);
    }
    expect(isReleaseMetadataOnly(files, metadata("invalid"), after)).toBe(false);
  });
  test("rejects manifest changes beyond root version and inconsistent versions", () => {
    expect(isReleaseMetadataOnly(files, before, { ...after, manifest: '{".":"1.4.0-beta.5","extra":"1.0.0"}' })).toBe(false);
    expect(isReleaseMetadataOnly(files, before, { ...after, manifest: before.manifest })).toBe(false);
    expect(isReleaseMetadataOnly(files, { ...before, manifest: "{}" }, after)).toBe(false);
  });
  test("rejects missing changelog version, malformed JSON or null objects", () => {
    expect(isReleaseMetadataOnly(files, before, { ...after, changelog: before.changelog })).toBe(false);
    for (const value of ["{", "null"]) {
      expect(isReleaseMetadataOnly(files, before, { ...after, package: value })).toBe(false);
      expect(isReleaseMetadataOnly(files, before, { ...after, manifest: value })).toBe(false);
    }
  });
});

const run: WorkflowRun = {
  id: 1, head_sha: sha, head_branch: "main", event: "push", path: ".github/workflows/ci.yml",
  status: "completed", conclusion: "success",
};

describe("exact main commit validation", () => {
  test("requires success on the exact commit, branch, event and workflow", () => {
    expect(validationState([run], sha, "ci.yml")).toBe("success");
    for (const change of [{ head_sha: "b".repeat(40) }, { head_branch: "feature" }, { event: "pull_request" }, { path: ".github/workflows/unrelated.yml" }]) {
      expect(validationState([{ ...run, ...change }], sha, "ci.yml")).toBe("pending");
    }
  });
  test("waits for missing, queued and running workflows", () => {
    expect(validationState([], sha, "ci.yml")).toBe("pending");
    for (const status of ["queued", "in_progress", "waiting"]) {
      expect(validationState([{ ...run, status }], sha, "ci.yml")).toBe("pending");
    }
  });
  test("blocks failed, cancelled, skipped or timed-out runs", () => {
    for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", null]) {
      expect(validationState([{ ...run, conclusion }], sha, "ci.yml")).toBe("failure");
    }
  });
  test("an older successful run cannot hide a newer failure or pending rerun", () => {
    expect(validationState([run, { ...run, id: 2, conclusion: "failure" }], sha, "ci.yml")).toBe("failure");
    expect(validationState([{ ...run, id: 2, status: "in_progress" }, run], sha, "ci.yml")).toBe("pending");
  });
});

describe("release validation wait", () => {
  const results = (state: "pending" | "success" | "failure") => [
    { workflow: "ci.yml", state }, { workflow: "install-smoke.yml", state },
  ];
  test("waits until both checks succeed", async () => {
    let calls = 0;
    let sleeps = 0;
    const reports: string[] = [];
    await waitForValidation(() => results(++calls === 2 ? "success" : "pending"), async () => { sleeps++; }, (message) => { reports.push(message); });
    expect(calls).toBe(2);
    expect(sleeps).toBe(1);
    expect(reports[1]).toContain("install-smoke.yml: success");
  });
  test("stops immediately when validation fails or its API is inaccessible", async () => {
    const sleep = async () => { throw new Error("must not sleep"); };
    await expect(waitForValidation(() => results("failure"), sleep, () => {})).rejects.toThrow("release is blocked");
    await expect(waitForValidation(() => { throw new Error("API denied"); }, sleep, () => {})).rejects.toThrow("API denied");
  });
  test("never treats missing workflows as success, and times out without a final sleep", async () => {
    let sleeps = 0;
    await expect(waitForValidation(() => [], async () => { sleeps++; }, () => {}, 3)).rejects.toThrow("Timed out");
    expect(sleeps).toBe(2);
    await expect(waitForValidation(() => results("success").slice(0, 1), async () => {}, () => {}, 1)).rejects.toThrow("Timed out");
  });
});
