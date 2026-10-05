// Both workflows must pass: CI covers source/artifacts; install smoke covers
// the delivery channels.
export const VALIDATION_WORKFLOWS = ["ci.yml", "install-smoke.yml"] as const;

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
