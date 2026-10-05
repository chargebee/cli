import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const workflowsDir = join(import.meta.dir, "../../../../.github/workflows");
const files = readdirSync(workflowsDir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

/**
 * Every third-party action and reusable workflow this repo calls, the Bun
 * toolchain version, and every `bun install` in CI must be pinned/frozen so a
 * release or a PR check always runs the exact dependency and action versions
 * this repo committed to, not whatever a floating tag, branch or `latest`
 * resolves to that day.
 */
describe("workflow supply-chain hygiene", () => {
  for (const file of files) {
    const src = readFileSync(join(workflowsDir, file), "utf8");

    test(`${file}: every non-local "uses:" is pinned to a commit SHA`, () => {
      const refs = [...src.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        if (ref.startsWith("./")) continue;
        expect(ref).toMatch(/@[0-9a-f]{40}$/);
      }
    });

    test(`${file}: does not float the Bun toolchain to "latest"`, () => {
      expect(src).not.toContain("bun-version: latest");
    });

    test(`${file}: every "bun install" is frozen to the committed lockfile`, () => {
      const installLines = src.split("\n").filter((l) => /(^|[\s|&])bun install\b/.test(l));
      for (const line of installLines) {
        expect(line).toContain("--frozen-lockfile");
      }
    });
  }
});

describe("release validation wiring", () => {
  const workflow = (name: string) => Bun.YAML.parse(readFileSync(join(workflowsDir, name), "utf8")) as any;
  for (const name of ["ci", "install-smoke"]) {
    test(`${name}: main runs have independent concurrency groups; only PR runs supersede each other`, () => {
      const { concurrency } = workflow(`${name}.yml`);
      expect(concurrency.group).toBe(name + "-${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}");
      expect(concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
    });
  }
  test("release creation is gated and every publishing path depends on it", () => {
    const { jobs } = workflow("release-please.yml");
    expect(jobs.validation.steps.some((step: any) => step.run === "bun run ci:wait")).toBe(true);
    expect(jobs.validation.permissions.actions).toBe("read");
    expect(jobs["release-please"].needs).toBe("validation");
    expect(jobs.build.needs).toBe("release-please");
    expect(jobs["upload-assets"].needs).toContain("build");
    expect(jobs.publish.needs).toContain("upload-assets");
  });
  test("published contents are required while README indexing cannot block install smoke", () => {
    const { jobs } = workflow("release-please.yml");
    const contents = jobs.publish.steps.find((step: any) => step.name === "Verify the published package contents");
    expect(contents.run).toContain('npm pack "@chargebee/cli@${VERSION}" --dry-run --ignore-scripts --json');
    expect(contents.run).toContain("node scripts/check-npm-package.mjs");
    expect(contents["continue-on-error"]).toBeUndefined();
    const metadata = jobs["npm-readme-metadata"];
    expect(metadata.needs).toEqual(["release-please", "publish"]);
    expect(metadata.steps.find((step: any) => step.id === "readme")["continue-on-error"]).toBe(true);
    expect(metadata.steps.some((step: any) => step.if === "steps.readme.outcome == 'failure'" && step.run.includes("::warning::"))).toBe(true);
    expect(jobs["npm-install-smoke"].needs).toEqual(["release-please", "publish"]);
    expect(jobs.publish.steps.some((step: any) => step.run?.includes('"@chargebee/cli@${VERSION}" readme'))).toBe(false);
  });
  test("every PR runs the full source, artifact and installation checks", () => {
    const ci = workflow("ci.yml").jobs;
    expect(ci.scope).toBeUndefined();
    for (const job of ["test", "cli", "npm-bundle"]) {
      expect(ci[job].needs).toBeUndefined();
      expect(ci[job].if).toBeUndefined();
    }
    expect(ci.test.with).toBeUndefined();
    expect(ci.build.needs).toBe("test");
    expect(ci.build.if).toBeUndefined();
    const source = workflow("source-checks.yml");
    expect(source.on.workflow_call.inputs).toBeUndefined();
    expect(source.jobs.codegen.if).toBeUndefined();
    expect(source.jobs.test.steps.some((step: any) => step.run === "bun run typecheck")).toBe(true);

    const install = workflow("install-smoke.yml").jobs;
    expect(install.scope).toBeUndefined();
    expect(install["release-smoke"]).toBeUndefined();
    for (const job of ["github-install", "npm-install", "windows-install"]) {
      expect(install[job].needs).toBeUndefined();
      expect(install[job].if).toBeUndefined();
    }
  });
});


describe("required check summaries", () => {
  for (const [file, name] of [["ci.yml", "CI required checks"], ["install-smoke.yml", "Install required checks"]]) {
    const { jobs } = Bun.YAML.parse(readFileSync(join(workflowsDir, file), "utf8")) as any;
    const gate = jobs["required-checks"];
    const step = gate.steps[0];
    const resultKey = (job: string) => job.toUpperCase().replaceAll("-", "_") + "_RESULT";
    const run = (env: Record<string, string>) => spawnSync("bash", ["-c", step.run], {
      env: { ...process.env, ...env }, encoding: "utf8",
    }).status;

    test(`${file}: stable gate waits for every job and runs after failures`, () => {
      expect(gate.name).toBe(name);
      expect(gate.if).toBe("${{ always() }}");
      expect([...gate.needs].sort()).toEqual(Object.keys(jobs).filter((job) => job !== "required-checks").sort());
      for (const job of gate.needs) {
        expect(step.env[resultKey(job)]).toBe("${{ needs." + job + ".result }}");
      }
      expect(gate["continue-on-error"]).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
    });

    const good: Record<string, string> = {};
    for (const job of gate.needs) good[resultKey(job)] = "success";
    test(`${file}: accepts every required job succeeding`, () => {
      expect(run(good)).toBe(0);
    });
    test(`${file}: rejects failed, cancelled, missing or skipped jobs`, () => {
      for (const job of gate.needs) {
        const key = resultKey(job);
        for (const result of ["failure", "cancelled", "", "skipped"]) {
          expect(run({ ...good, [key]: result })).not.toBe(0);
        }
      }
    });
  }
});
