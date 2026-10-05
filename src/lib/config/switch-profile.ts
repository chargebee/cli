import { humanLog, diagnostic, exitCommand, jsonResult } from "../output.js";
import { assertValidProfileName, listProfiles, loadProfile } from "./profiles.js";
import { readConfig, writeConfig } from "./store.js";
import { siteMode } from "../api/write-gate.js";

/** `auth switch`. `domain` is still written as `CHARGEBEE_DOMAIN`. */
export async function switchProfileAction(name?: string): Promise<void> {
  if (name !== undefined) {
    try {
      assertValidProfileName(name);
    } catch (err) {
      diagnostic(`  ${err instanceof Error ? err.message : String(err)}`);
      exitCommand(1);
    }
  }

  const cfg = await readConfig();
  const active = cfg.activeProfile || cfg.domain || null;

  let chosen = name;

  if (!chosen) {
    const profiles = await listProfiles();
    if (profiles.length === 0) {
      diagnostic("  No saved profiles. Run 'chargebee auth add --profile <name>' to add one.");
      exitCommand(1);
    }

    const { canPrompt, select, isCancel } = await import("../prompts.js");
    if (!canPrompt()) {
      diagnostic("  Profile name required in a non-interactive shell: chargebee auth switch <name>");
      diagnostic(`  Saved profiles: ${profiles.map((p) => p.name).join(", ")}`);
      exitCommand(1);
    }
    const result = await select({
      message: "Switch active profile",
      options: profiles.map(({ name: pname, data }) => ({
        value: pname,
        label: `${pname}${pname === active ? "  (active)" : ""}`,
        hint: `${data.site}  ${siteMode(data.site, data.api_key)}`,
      })),
      initialValue: active && profiles.some((p) => p.name === active) ? active : profiles[0]?.name,
    });

    if (isCancel(result)) {
      humanLog("  Cancelled.");
      return;
    }

    chosen = result as string;

    if (chosen === active) {
      humanLog(`  Already active: "${chosen}". No change.`);
      return;
    }
  }

  const p = await loadProfile(chosen);
  if (!p) {
    diagnostic(`  Profile "${chosen}" not found.`);
    diagnostic(`  Run 'chargebee auth list' to see saved profiles.`);
    exitCommand(1);
  }

  await writeConfig({
    domain: p.site,
    activeProfile: chosen,
  });

  const mode = siteMode(p.site, p.api_key);
  jsonResult({ active_profile: chosen, site: p.site, mode });
  humanLog(`  \x1b[32m✓\x1b[0m  Switched to "${chosen}" (${p.site}, ${mode})`);
  if (active && active !== chosen) humanLog(`     ${active} → ${chosen}`);
}

