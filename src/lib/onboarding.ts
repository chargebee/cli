import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_ALIAS_NAME, isAliasSupported, setAlias } from "./alias.js";
import { configDir } from "./config/store.js";
import { userHome } from "./config/user-home.js";
import {
  detectAgents,
  AGENT_CONFIGS,
  installSkill,
  isInstalled,
  resolveAgentsForAdd,
} from "./skills/index.js";

const ONBOARDING_FILE = "onboarding.json";
export const NO_ONBOARDING_ENV = "CHARGEBEE_CLI_NO_ONBOARDING";

export interface OnboardingGate {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  env?: NodeJS.Dict<string | undefined>;
}

export interface OnboardingResult {
  asked: boolean;
  /** True when the user accepted the skill confirm (install may no-op if already present). */
  skill: boolean;
  /** True when the user accepted the alias confirm. */
  alias: boolean;
}

function envFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const s = value.trim().toLowerCase();
  return s !== "" && s !== "0" && s !== "false" && s !== "no";
}

export function onboardingPath(): string {
  return join(configDir(), ONBOARDING_FILE);
}

export function onboardingOffered(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(onboardingPath(), "utf-8")) as {
      offered?: unknown;
    };
    return parsed.offered === true;
  } catch {
    return false;
  }
}

export function markOnboardingOffered(): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(onboardingPath(), `${JSON.stringify({ offered: true })}\n`, {
    mode: 0o600,
  });
}

/**
 * Whether the two post-install confirms may run.
 * TTY + not CI; skip when install.sh (or a previous run) already asked.
 */
export function shouldOfferOnboarding(opts: OnboardingGate = {}): boolean {
  const env = opts.env ?? process.env;
  const stdin = opts.stdinIsTTY ?? Boolean(process.stdin.isTTY);
  const stdout = opts.stdoutIsTTY ?? Boolean(process.stdout.isTTY);
  if (!stdin || !stdout) return false;
  if (env.TERM === "dumb") return false;
  if (envFlag(env.CI)) return false;
  if (envFlag(env[NO_ONBOARDING_ENV])) return false;
  if (onboardingOffered()) return false;
  return true;
}

async function installSkillAtHome(): Promise<boolean> {
  const home = userHome();
  const agents = await resolveAgentsForAdd(undefined, false, { projectDir: home, global: true });
  if (!agents) return false;

  let installed = false;
  for (const agent of agents) {
    if (await isInstalled(home, agent, true)) {
      console.log(`  ${AGENT_CONFIGS[agent].name}: already installed (skipped)`);
      installed = true;
      continue;
    }
    const result = await installSkill(home, agent, true, true);
    console.log(`  Installed Chargebee CLI skill for ${AGENT_CONFIGS[agent].name}`);
    console.log(`    ${result.installPath}`);
    installed = true;
  }
  return installed;
}

async function confirmOrCancel(message: string, initialValue: boolean): Promise<boolean | "cancel"> {
  const { confirm, isCancel } = await import("./prompts.js");
  const result = await confirm({ message, initialValue });
  if (isCancel(result)) return "cancel";
  return result === true;
}

async function runOffers(): Promise<{ skill: boolean; alias: boolean }> {
  const detected = detectAgents(userHome());
  const skillAnswer = await confirmOrCancel(
    "Install the Chargebee CLI skill for your coding agent?",
    detected.length > 0,
  );
  if (skillAnswer === "cancel") return { skill: false, alias: false };

  let skill = false;
  if (skillAnswer) skill = await installSkillAtHome();
  else console.log("  Later: chargebee skills add --global");

  let alias = false;
  if (isAliasSupported()) {
    const aliasAnswer = await confirmOrCancel(
      "Add a cb shortcut for the chargebee command?",
      true,
    );
    if (aliasAnswer === "cancel") return { skill, alias: false };

    if (aliasAnswer) {
      try {
        await setAlias(DEFAULT_ALIAS_NAME);
        alias = true;
      } catch (err) {
        console.log(err instanceof Error ? err.message : String(err));
      }
    } else {
      console.log("  Later: chargebee alias set");
    }
  }

  return { skill, alias };
}

/**
 * Offer skill + `cb` alias once after interactive auth add.
 * Always persists the marker after asking so we never nag.
 */
export async function maybeOfferOnboarding(): Promise<OnboardingResult> {
  const skipped: OnboardingResult = { asked: false, skill: false, alias: false };
  if (!shouldOfferOnboarding()) return skipped;
  try {
    const result = await runOffers();
    return { asked: true, ...result };
  } finally {
    markOnboardingOffered();
  }
}
