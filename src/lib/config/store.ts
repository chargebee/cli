import { readFileSync } from "node:fs";
import { join } from "node:path";
import { userHome } from "./user-home.js";
import { writeFileAtomic } from "./atomic-write.js";

/** CLI config directory: ~/.chargebee/cli */
export function configDir(): string {
  return process.env.CHARGEBEE_CONFIG_DIR || join(userHome(), ".chargebee", "cli");
}

/** Path to the config file. */
function configPath(): string {
  return join(configDir(), "config");
}

/** Persisted configuration values. */
export interface EnvVars {
  domain: string;
  activeProfile?: string;
}

/** Read config from ~/.chargebee/cli/config. */
export async function readConfig(): Promise<EnvVars> {
  const path = configPath();
  let content: string;

  try {
    const { readFile } = await import("node:fs/promises");
    content = await readFile(path, "utf-8");
  } catch {
    return {
      domain: "",
      activeProfile: undefined,
    };
  }

  const parsed = parseConfigContent(content);
  return {
    domain: parsed.domain,
    activeProfile: parsed.activeProfile,
  };
}

/** Write config to ~/.chargebee/cli/config. */
export async function writeConfig(vars: Partial<EnvVars>): Promise<void> {
  const dir = configDir();
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const current = await readConfig();
  const domain = vars.domain ?? current.domain ?? "";
  const activeProfile = vars.activeProfile ?? current.activeProfile ?? "";

  let content = `CHARGEBEE_DOMAIN=${domain}\n`;
  if (activeProfile) content += `CHARGEBEE_ACTIVE_PROFILE=${activeProfile}\n`;
  await writeFileAtomic(configPath(), content);
}

/**
 * Parse key=value config file content. Leftover CHARGEBEE_ENV / CHARGEBEE_REGION
 * keys are ignored (the API host is the profile `host`).
 */
function parseConfigContent(content: string): {
  domain: string;
  activeProfile: string;
} {
  const result = { domain: "", activeProfile: "" };

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip quotes
    val = val.replace(/^["']|["']$/g, "");

    switch (key) {
      case "CHARGEBEE_DOMAIN":
        result.domain = val;
        break;
      case "CHARGEBEE_ACTIVE_PROFILE":
        result.activeProfile = val;
        break;
    }
  }

  return result;
}

/**
 * Sync site peek for root help (cannot be async). Same env rule as resolveAuth:
 * both CHARGEBEE_SITE and CHARGEBEE_API_KEY, else the active profile file.
 * Returns null when nothing is configured.
 */
export function peekActiveSiteSync(): string | null {
  try {
    if (process.env.CHARGEBEE_SITE && process.env.CHARGEBEE_API_KEY) {
      return process.env.CHARGEBEE_SITE;
    }

    const dir = configDir();
    const parsed = parseConfigContent(readFileSync(join(dir, "config"), "utf-8"));
    if (!parsed.activeProfile) return null;

    const profile = JSON.parse(
      readFileSync(join(dir, "profiles", `${parsed.activeProfile}.json`), "utf-8"),
    ) as { site?: string };
    return profile.site || null;
  } catch {
    return null;
  }
}

/**
 * Drop the active profile pointer and site domain together so `auth status`
 * reads as unconfigured. Empty string is required: omit-means-keep in writeConfig.
 */
export async function clearActiveConnection(): Promise<void> {
  await writeConfig({
    domain: "",
    activeProfile: "",
  });
}
