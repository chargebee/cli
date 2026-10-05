import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  markOnboardingOffered,
  maybeOfferOnboarding,
  NO_ONBOARDING_ENV,
  onboardingOffered,
  shouldOfferOnboarding,
} from "../../../lib/onboarding.js";
import {
  __resetPromptsForTest,
  __setPromptsForTest,
} from "../../../lib/prompts.js";
import { createEnvPatcher } from "../../../lib/test-support/_helpers.js";

const open = {
  stdinIsTTY: true,
  stdoutIsTTY: true,
  env: { TERM: "xterm" } as NodeJS.Dict<string | undefined>,
};

describe("shouldOfferOnboarding", () => {
  const env = createEnvPatcher();
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-onboard-"));
    env.set("CHARGEBEE_CONFIG_DIR", dir);
  });

  afterEach(() => {
    env.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("allows a TTY, non-CI session", () => {
    expect(shouldOfferOnboarding(open)).toBe(true);
  });

  it("skips when stdin or stdout is not a TTY", () => {
    expect(shouldOfferOnboarding({ ...open, stdinIsTTY: false })).toBe(false);
    expect(shouldOfferOnboarding({ ...open, stdoutIsTTY: false })).toBe(false);
  });

  it("skips CI and TERM=dumb", () => {
    expect(shouldOfferOnboarding({ ...open, env: { ...open.env, CI: "true" } })).toBe(false);
    expect(shouldOfferOnboarding({ ...open, env: { ...open.env, CI: "1" } })).toBe(false);
    expect(shouldOfferOnboarding({ ...open, env: { ...open.env, TERM: "dumb" } })).toBe(false);
  });

  it("skips CHARGEBEE_CLI_NO_ONBOARDING", () => {
    expect(
      shouldOfferOnboarding({ ...open, env: { ...open.env, [NO_ONBOARDING_ENV]: "1" } }),
    ).toBe(false);
  });

  it("skips after the marker is written (including install.sh JSON)", () => {
    writeFileSync(join(dir, "onboarding.json"), '{"offered":true}\n');
    expect(onboardingOffered()).toBe(true);
    expect(shouldOfferOnboarding(open)).toBe(false);
  });

  it("treats missing or corrupt marker as not offered", () => {
    expect(onboardingOffered()).toBe(false);
    writeFileSync(join(dir, "onboarding.json"), "{not json");
    expect(onboardingOffered()).toBe(false);
  });
});

describe("maybeOfferOnboarding", () => {
  const env = createEnvPatcher();
  let dir: string;
  let home: string;
  const CANCEL = Symbol("clack-cancel");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-onboard-run-"));
    home = mkdtempSync(join(tmpdir(), "cb-onboard-home-"));
    env.set("CHARGEBEE_CONFIG_DIR", dir);
    env.set("HOME", home);
    env.set("SHELL", "/bin/zsh");
    env.set("CI", undefined);
    env.set(NO_ONBOARDING_ENV, undefined);
    env.set("TERM", "xterm");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    __setPromptsForTest({
      isCancel: (v) => v === CANCEL,
      confirm: async () => false,
    });
  });

  afterEach(() => {
    __resetPromptsForTest();
    env.restore();
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("writes the marker on No", async () => {
    const result = await maybeOfferOnboarding();
    expect(result.asked).toBe(true);
    expect(result.skill).toBe(false);
    expect(result.alias).toBe(false);
    expect(onboardingOffered()).toBe(true);
  });

  it("writes the marker on cancel", async () => {
    __setPromptsForTest({
      isCancel: (v) => v === CANCEL,
      confirm: async () => CANCEL,
    });
    const result = await maybeOfferOnboarding();
    expect(result.asked).toBe(true);
    expect(onboardingOffered()).toBe(true);
    expect(readFileSync(join(dir, "onboarding.json"), "utf-8")).toContain('"offered":true');
  });

  it("keeps going and records the offer when a foreign cb alias blocks the shortcut", async () => {
    const rc = join(home, ".zshrc");
    writeFileSync(rc, "alias cb='couchbase-cli'\n");
    let confirms = 0;
    __setPromptsForTest({
      isCancel: (v) => v === CANCEL,
      // Decline the skill, accept the alias.
      confirm: async () => confirms++ === 1,
    });
    const result = await maybeOfferOnboarding();
    expect(result.asked).toBe(true);
    expect(result.alias).toBe(false);
    expect(onboardingOffered()).toBe(true);
    expect(readFileSync(rc, "utf-8")).toBe("alias cb='couchbase-cli'\n");
  });

  it("is a no-op when the marker already exists", async () => {
    markOnboardingOffered();
    let confirms = 0;
    __setPromptsForTest({
      confirm: async () => {
        confirms += 1;
        return false;
      },
    });
    const result = await maybeOfferOnboarding();
    expect(result.asked).toBe(false);
    expect(confirms).toBe(0);
  });
});
