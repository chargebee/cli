import { describe, expect, test } from "bun:test";
import { validationState, waitForValidation, type WorkflowRun } from "../../../tools/release-ci-policy.js";

const sha = "a".repeat(40);

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
