import type { Command } from "commander";

import { humanLog, diagnostic, exitCommand, isJsonMode, jsonResult } from "../lib/output.js";
import { readConfig, writeConfig, clearActiveConnection } from "../lib/config/store.js";
import { assertValidProfileName, loadProfile, listProfiles, saveProfile, deleteProfile, renameProfile, profilePath, migrateLegacyCredentials } from "../lib/config/profiles.js";
import { apiBaseURL } from "../lib/config/urls.js";
import { displayHost, parseHost, parseSiteInput, persistableHost, PRODUCTION_HOST, type ApiHost } from "../lib/config/host.js";
import { DEFAULT_REGION, REGIONS, parseRegion, regionLabel, type Region } from "../lib/config/region.js";
import { keychainDisabledReason } from "../lib/config/keychain.js";
import { detectCatalog, resolveApiHost, resolveRegion, setHostOverride } from "../lib/api/sdk.js";
import { siteCatalogStatusLabel } from "../lib/api/catalog-gate.js";
import { siteMode } from "../lib/api/write-gate.js";
import { maskApiKey } from "../lib/config/mask.js";
import { maybeOfferOnboarding } from "../lib/onboarding.js";
import { setCommandGroup } from "./help.js";
import { sectionTitle } from "../lib/help-style.js";
import { switchProfileAction } from "../lib/config/switch-profile.js";
import { EXIT_CODES } from "../lib/exit-codes.js";

const DEFAULT_PROFILE = "default";

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command("auth")
    .description("Manage API-key authentication and saved profiles")
    .enablePositionalOptions()
    .action(() => { auth.outputHelp(); });
  const add = auth
    .command("add")
    .description("Connect a site using an API key")
    .option("-s, --site <site>", "Chargebee site name (e.g. acme-test)")
    .option("-k, --api-key <key>", "Chargebee API key (prefer CHARGEBEE_API_KEY to avoid shell history)")
    .option("-p, --profile <name>", "Save under a named profile (default: \"default\")")
    .option("-r, --region <region>", `Region the site's data lives in: ${REGIONS.join(" | ")} (default: ${DEFAULT_REGION})`)
    .option("--host <host>", "API host suffix over HTTPS (default: chargebee.com)")
    .action(async (opts: { site?: string; apiKey?: string; profile?: string; region?: string; host?: string }) => {
      const siteFromEnv = !opts.site && !!process.env.CHARGEBEE_SITE;
      const apiKeyFromEnv = !opts.apiKey && !!process.env.CHARGEBEE_API_KEY;
      let site = opts.site || process.env.CHARGEBEE_SITE;
      let apiKey = opts.apiKey || process.env.CHARGEBEE_API_KEY;
      const interactive = !site || !apiKey;

      // Validated up front, before any prompt, network, or keychain call.
      let region: Region | undefined;
      if (opts.region) {
        try {
          region = parseRegion(opts.region);
        } catch (err) {
          diagnostic(`  \x1b[31m✗\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
          exitCommand(1);
        }
      }

      // Interactive prompts for anything not supplied. Clack's `intro()` only
      // runs on this path: flagged/env auth add stays quiet for scripts.
      if (!site || !apiKey) {
        const { canPrompt, text, password, select, isCancel, cancel, intro } = await import("../lib/prompts.js");
        if (!canPrompt()) {
          const missing = [!site && "--site <site>", !apiKey && "--api-key <key>"].filter(Boolean).join(" and ");
          diagnostic(`  auth add needs a terminal to prompt for ${missing}; stdin/stdout is not a TTY.`);
          diagnostic("  Non-interactive usage:");
          diagnostic("    chargebee auth add --site <site> --api-key <key> [--profile <name>]");
          diagnostic("    or export CHARGEBEE_SITE and CHARGEBEE_API_KEY (prefer the env var for the key).");
          exitCommand(1);
        }
        intro("Welcome to Chargebee CLI — let's connect your site.");

        if (!region) {
          const r = await select({
            message: "Your site's region",
            initialValue: DEFAULT_REGION,
            options: REGIONS.map((value) => ({
              value,
              label: value,
              // Clack wraps the hint in parentheses, so it carries none itself.
              hint: value === DEFAULT_REGION ? `${regionLabel(value)} — default` : regionLabel(value),
            })),
          });
          if (isCancel(r)) { cancel("Cancelled."); return; }
          region = parseRegion(String(r));
        }

        if (!site) {
          const r = await text({
            message: "Site name",
            placeholder: "acme-test",
            validate: (v) => {
              const trimmed = (v ?? "").trim();
              if (!trimmed) return "Site name is required";
              try {
                parseSiteInput(trimmed);
              } catch (err) {
                return err instanceof Error ? err.message : String(err);
              }
              return undefined;
            },
          });
          if (isCancel(r)) { cancel("Cancelled."); return; }
          site = ((r as string | undefined) ?? "").trim();
        }

        if (!apiKey) {
          const r = await password({
            message: "API key",
            validate: (v) => ((v ?? "").trim() ? undefined : "API key is required"),
          });
          if (isCancel(r)) { cancel("Cancelled."); return; }
          apiKey = ((r as string | undefined) ?? "").trim();
        }

        // Third prompt only on this interactive path. `--profile` still wins.
        if (!opts.profile) {
          const r = await text({
            message: "Profile name (leave empty to overwrite default)",
            placeholder: "default",
            validate: (v) => {
              const trimmed = (v ?? "").trim();
              if (!trimmed) return undefined;
              try {
                assertValidProfileName(trimmed);
              } catch (err) {
                return err instanceof Error ? err.message : String(err);
              }
              return undefined;
            },
          });
          if (isCancel(r)) { cancel("Cancelled."); return; }
          opts.profile = ((r as string | undefined) ?? "").trim() || DEFAULT_PROFILE;
        }
      }

      // Normalise + validate: accept full URLs and `{site}.{host}` hostnames,
      // reject anything that is not a plain DNS label before any network or
      // keychain call (a `#`, `?`, `/` or `@` would redirect the key elsewhere).
      let parsed: ReturnType<typeof parseSiteInput>;
      try {
        parsed = parseSiteInput(site);
      } catch (err) {
        diagnostic(`  \x1b[31m✗\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
        exitCommand(1);
      }
      site = parsed.site;
      // This invocation only: --host, a host embedded in the site string, or
      // production. The active profile and CHARGEBEE_HOST do not apply.
      let chosenHost: ApiHost;
      try {
        if (opts.host) chosenHost = parseHost(opts.host);
        else if (parsed.hostFromInput) chosenHost = parsed.hostFromInput;
        else chosenHost = PRODUCTION_HOST;
      } catch (err) {
        diagnostic(`  \x1b[31m✗\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
        exitCommand(1);
      }
      // Pin it so credential verification cannot fall through to the active profile.
      setHostOverride(persistableHost(chosenHost));
      let profileName: string;
      try {
        profileName = assertValidProfileName(opts.profile || DEFAULT_PROFILE);
      } catch (err) {
        diagnostic(`  \x1b[31m✗\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
        exitCommand(1);
      }

      const { spinner } = await import("../lib/prompts.js");
      const s = isJsonMode() ? { start() {}, stop() {} } : spinner();
      s.start("Verifying credentials…");
      let catalog: { productCatalogVersion?: string; responseSchemaType?: string };
      try {
        catalog = await detectCatalog(site, apiKey);
        s.stop("Credentials verified");
      } catch (err) {
        s.stop("Verification failed");
        const msg = err instanceof Error ? err.message : String(err);
        diagnostic(`  \x1b[31m✗\x1b[0m ${msg}`);
        exitCommand(1);
      }

      if (siteFromEnv || apiKeyFromEnv) {
        humanLog(`  Saving CHARGEBEE_SITE/CHARGEBEE_API_KEY from the environment as profile ${profileName}.`);
      }

      // Non-interactive runs (flags or environment) take the default.
      const savedRegion = region ?? DEFAULT_REGION;

      const apiHost = chosenHost;
      const saved = await saveProfile(profileName, {
        site,
        api_key: apiKey,
        product_catalog_version: catalog.productCatalogVersion,
        chargebee_response_schema_type: catalog.responseSchemaType,
        ...(apiHost.isProduction ? {} : { host: persistableHost(apiHost) }),
        ...(savedRegion === DEFAULT_REGION ? {} : { region: savedRegion }),
      });
      await writeConfig({ domain: site, activeProfile: profileName });
      jsonResult({ configured: true, profile: profileName, site, region: savedRegion,
        host: persistableHost(apiHost), product_catalog_version: catalog.productCatalogVersion ?? null,
        chargebee_response_schema_type: catalog.responseSchemaType ?? null, key_storage: saved.backend });

      humanLog(`  \x1b[32m✓\x1b[0m Connected to ${site}  (profile: ${profileName})`);
      humanLog(`    Region  : ${savedRegion}  (${regionLabel(savedRegion)})`);
      if (!apiHost.isProduction) {
        humanLog(`    Host    : ${persistableHost(apiHost)}`);
      }
      humanLog(
        `    Key     : ${
          saved.backend === "keychain" ? "stored in the OS keychain" : `stored in ${profilePath(profileName)} (OS keychain unavailable: ${saved.reason})`
        }`,
      );
      if (process.env.CHARGEBEE_CONFIG_DIR && keychainDisabledReason() === "CHARGEBEE_CONFIG_DIR is set") {
        humanLog("    Note    : CHARGEBEE_CONFIG_DIR is set, so keys are stored in the profile file, not the OS keychain.");
      }
      await migrateLegacyCredentials();
      const catalogLabel = siteCatalogStatusLabel(catalog.productCatalogVersion, catalog.responseSchemaType);
      if (catalogLabel) {
        humanLog(`    Catalog : ${catalogLabel}`);
      }

      const onboarding = interactive ? await maybeOfferOnboarding() : { asked: false, skill: false, alias: false };

      humanLog();
      humanLog("  Next steps:");
      humanLog("    chargebee customer list                 # try an API command");
      humanLog("    chargebee auth status                   # show connection (test vs live)");
      humanLog("    chargebee auth switch                   # switch saved profiles");
      humanLog("    chargebee --use-profile <name> customer list  # one-off site override");
      if (onboarding.asked && !onboarding.skill) {
        humanLog("    chargebee skills add                    # install agent skills");
      }
      if (onboarding.asked && !onboarding.alias) {
        humanLog("    chargebee alias set                     # add a cb shortcut");
      }
    });

  setCommandGroup(auth, "core");
  add.addHelpText(
    "after",
    `
${sectionTitle("EXAMPLES")}
  chargebee auth add                     Connect a site interactively
  chargebee auth add --profile staging   Save credentials as staging

Writes are blocked on live sites: a site whose name doesn't end in -test,
unless its API key starts with test_. Prefer CHARGEBEE_API_KEY over --api-key
so the secret is not stored in shell history.

--region (${REGIONS.join(" | ")}) records where the site is hosted and is used to
reach the regional webhook tunnel for \`chargebee listen\`. API requests are
identical in every region. Defaults to ${DEFAULT_REGION}.
`,
  );

  auth
    .command("list")
    .description("List saved profiles")
    .action(async () => {
      const profiles = await listProfiles();
      const cfg = await readConfig();

      if (jsonResult({ profiles: profiles.map(({ name, data }) => ({
        name, site: data.site, active: name === cfg.activeProfile,
        region: data.region ?? DEFAULT_REGION, host: data.host ?? displayHost(PRODUCTION_HOST),
        product_catalog_version: data.product_catalog_version ?? null,
        chargebee_response_schema_type: data.chargebee_response_schema_type ?? null,
        mode: siteMode(data.site, data.api_key), key_storage: data.api_key_source ?? "file",
      })) })) return;
      if (profiles.length === 0) {
        humanLog("  No profiles saved.");
        humanLog("  Run 'chargebee auth add' to connect a site.");
        return;
      }

      humanLog();
      humanLog(`  ${"PROFILE".padEnd(14)} ${"SITE".padEnd(28)} ${"REGION".padEnd(6)} ${"HOST".padEnd(16)} ${"CATALOG".padEnd(8)} ${"MODE".padEnd(6)} ${"STORE".padEnd(9)} KEY`);
      humanLog(`  ${"─".repeat(14)} ${"─".repeat(28)} ${"─".repeat(6)} ${"─".repeat(16)} ${"─".repeat(8)} ${"─".repeat(6)} ${"─".repeat(9)} ${"─".repeat(8)}`);

      for (const { name, data } of profiles) {
        const isActive = name === cfg.activeProfile;
        const marker = isActive ? "\x1b[32m●\x1b[0m" : "○";
        const keyUnavailable = !data.api_key && data.api_key_source === "keychain";
        const maskedKey = keyUnavailable ? "unavailable (keychain)" : maskApiKey(data.api_key);
        const pcv = data.product_catalog_version ?? "—";
        const mode = siteMode(data.site, data.api_key);
        const store = data.api_key_source === "keychain" ? "keychain" : "file";
        const activeLabel = isActive ? "  \x1b[32m(active)\x1b[0m" : "";
        const region = data.region ?? DEFAULT_REGION;
        const host = data.host ?? displayHost(PRODUCTION_HOST);
        humanLog(`  ${marker} ${name.padEnd(13)} ${data.site.padEnd(28)} ${region.padEnd(6)} ${host.padEnd(16)} ${pcv.padEnd(8)} ${mode.padEnd(6)} ${store.padEnd(9)} ${maskedKey}${activeLabel}`);
      }
      humanLog();
    });

  auth
    .command("switch [profile]")
    .description("Switch the active profile")
    .action(async (name?: string) => {
      await switchProfileAction(name);
    });

  auth
    .command("remove [name]")
    .description("Remove a saved profile")
    .option("-y, --yes", "Skip confirmation prompt")
    .addHelpText(
      "after",
      `
${sectionTitle("EXAMPLES")}
  chargebee auth remove my-profile
  chargebee auth remove my-profile --yes

Environment-variable credentials (CHARGEBEE_SITE / CHARGEBEE_API_KEY) are not
stored profiles. Unset those in your shell to stop using them.`,
    )
    .action(async (name: string | undefined, opts: { yes?: boolean }) => {
      await removeProfileAction(name, opts.yes === true);
    });

  auth
    .command("rename <old> <new>")
    .description("Rename a saved profile without re-entering the API key")
    .addHelpText(
      "after",
      `
${sectionTitle("EXAMPLES")}
  chargebee auth rename default prod`,
    )
    .action(async (oldName: string, newName: string) => {
      await renameProfileAction(oldName, newName);
    });

  auth
    .command("status")
    .alias("whoami")
    .description("Show the active connection status")
    .action(() => statusAction(program));

  const login = program
    .command("login")
    .description("Show API-key authentication guidance")
    .action(() => {
      const message = "Chargebee CLI currently supports API-key authentication only.";
      if (jsonResult({ supported: false, message, next_command: "chargebee auth add" })) return;
      humanLog(`${message} Run chargebee auth add to connect your site using an API key.`);
    });
  setCommandGroup(login, "core");

  // Convenient top-level alias: `chargebee whoami`.
  program
    .command("whoami", { hidden: true })
    .description("Show the active connection status")
    .action(() => statusAction(program));
}

async function statusAction(program: Command): Promise<void> {
  const cfg = await readConfig();
  const envSite = process.env.CHARGEBEE_SITE;
  const envKey = process.env.CHARGEBEE_API_KEY;

  let site: string | undefined;
  let apiKey: string | undefined;
  let authSource: string;
  let pcv: string | undefined;
  let schema: string | undefined;
  let keyStore: string | undefined;

  if (envSite && envKey) {
    site = parseSiteInput(envSite).site;
    apiKey = envKey;
    authSource = "environment variables";
  } else if (envSite || envKey) {
    const missing = envSite ? "CHARGEBEE_API_KEY" : "CHARGEBEE_SITE";
    diagnostic(`  ${missing} is not set — both vars must be exported together.`);
    exitCommand(EXIT_CODES.UNCONFIGURED);
  } else if (cfg.activeProfile) {
    await migrateLegacyCredentials();
    const p = await loadProfile(cfg.activeProfile);
    if (!p) {
      diagnostic(`  Active profile "${cfg.activeProfile}" not found on disk.`);
      diagnostic(`  Run: chargebee auth add --profile ${cfg.activeProfile}`);
      exitCommand(EXIT_CODES.UNCONFIGURED);
    }
    site = p.site;
    apiKey = p.api_key;
    authSource = `profile: ${cfg.activeProfile}`;
    pcv = p.product_catalog_version;
    schema = p.chargebee_response_schema_type;
    keyStore = p.api_key_source === "keychain" ? "OS keychain" : "profile file";
  } else {
    jsonResult({ configured: false });
    humanLog("  Not configured.");
    humanLog();
    humanLog("  Run: chargebee auth add");
    humanLog("  Or:  export CHARGEBEE_SITE=your-site CHARGEBEE_API_KEY=test_xxx");
    return;
  }

  const apiHost = await resolveApiHost();
  const url = site ? apiBaseURL(site, apiHost) : "";
  const version = program.version() ?? "0.0.0";
  const mode = site ? siteMode(site, apiKey) : undefined;

  // A bad CHARGEBEE_REGION or saved region must not break a diagnostic
  // command; the line is dropped and `listen` reports the value properly.
  let region: Region | null = null;
  try {
    region = await resolveRegion();
  } catch {
    region = null;
  }

  if (jsonResult({ configured: true, site, region, mode, auth_source: authSource,
    product_catalog_version: pcv ?? null, chargebee_response_schema_type: schema ?? null,
    key_storage: keyStore === "OS keychain" ? "keychain" : keyStore ? "file" : null, api_url: url, cli_version: version })) return;
  humanLog(`  \x1b[32m✓\x1b[0m Connected  (${authSource})`);
  humanLog(`    Site        : ${site}`);
  if (region) humanLog(`    Region      : ${region}`);
  if (mode) humanLog(`    Mode        : ${mode}`);
  const catalogLabel = siteCatalogStatusLabel(pcv, schema);
  if (catalogLabel) humanLog(`    Catalog     : ${catalogLabel}`);
  if (keyStore) humanLog(`    Key storage : ${keyStore}`);
  humanLog(`    API URL     : ${url}`);
  humanLog(`    CLI Version : ${version}`);
}

/**
 * Delete a saved profile and, when it was the active one, either switch to a
 * remaining profile (interactive) or disconnect. Env-var credentials are not
 * profiles and are never touched here.
 */
async function removeProfileAction(name: string | undefined, yes: boolean): Promise<void> {
  const { confirm, select, isCancel, cancel } = await import("../lib/prompts.js");
  const profiles = await listProfiles();

  if (profiles.length === 0) {
    diagnostic("  No saved profiles to remove.");
    diagnostic("  Run 'chargebee auth list' to see saved profiles.");
    exitCommand(1);
  }

  let target = name;
  if (target) {
    try {
      assertValidProfileName(target);
    } catch (err) {
      diagnostic(`  ${err instanceof Error ? err.message : String(err)}`);
      exitCommand(1);
    }
  }
  if (!target) {
    if (isJsonMode() || !process.stdin.isTTY) {
      diagnostic("  Profile name required: chargebee auth remove <name>");
      exitCommand(1);
    }
    const picked = await select({
      message: "Remove which profile?",
      options: profiles.map((p) => ({
        value: p.name,
        label: p.name,
        hint: `${p.data.site}  ${siteMode(p.data.site, p.data.api_key)}`,
      })),
    });
    if (isCancel(picked)) { cancel("Cancelled."); return; }
    target = picked as string;
  }

  if (!profiles.some((p) => p.name === target)) {
    diagnostic(`  Profile "${target}" not found.`);
    diagnostic("  Run 'chargebee auth list' to see saved profiles.");
    exitCommand(1);
  }

  if (!yes) {
    if (isJsonMode() || !process.stdin.isTTY) {
      diagnostic(`  Refusing to remove "${target}" without confirmation. Re-run with --yes.`);
      exitCommand(1);
    }
    const ok = await confirm({ message: `Remove profile "${target}" and its saved API key? Credential cleanup failures will be reported.` });
    if (isCancel(ok) || !ok) { cancel("Cancelled."); return; }
  }

  await deleteProfile(target);

  const cfg = await readConfig();
  if (cfg.activeProfile !== target) {
    jsonResult({ removed: target, active_profile: cfg.activeProfile ?? null });
    humanLog(`  \x1b[32m✓\x1b[0m Removed profile "${target}"`);
    return;
  }

  // The active profile was removed — pick the new active connection.
  const remaining = profiles.filter((p) => p.name !== target);
  if (remaining.length === 0) {
    await clearActiveConnection();
    jsonResult({ removed: target, active_profile: null });
    humanLog(`  \x1b[32m✓\x1b[0m Removed profile "${target}"`);
    humanLog("  Not configured. Run: chargebee auth add");
    return;
  }

  if (!yes && !isJsonMode() && process.stdin.isTTY) {
    const next = await select({
      message: "Set which profile active now?",
      options: [
        ...remaining.map((p) => ({
          value: p.name,
          label: p.name,
          hint: `${p.data.site}  ${siteMode(p.data.site, p.data.api_key)}`,
        })),
        { value: "", label: "None (disconnect)" },
      ],
    });
    if (!isCancel(next) && (next as string) !== "") {
      const chosen = next as string;
      const p = remaining.find((r) => r.name === chosen)!;
      await writeConfig({ domain: p.data.site, activeProfile: chosen });
      humanLog(`  \x1b[32m✓\x1b[0m Removed "${target}". Active profile: "${chosen}" (${p.data.site})`);
      return;
    }
  }

  await clearActiveConnection();
  jsonResult({ removed: target, active_profile: null });
  humanLog(`  \x1b[32m✓\x1b[0m Removed profile "${target}"`);
  humanLog("  No active profile. Run 'chargebee auth switch <name>' to pick one.");
}

/** Rename a profile, moving the active pointer with it when needed. */
async function renameProfileAction(oldName: string, newName: string): Promise<void> {
  try {
    await renameProfile(oldName, newName);
  } catch (err) {
    diagnostic(`  \x1b[31m✗\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
    exitCommand(1);
  }

  const cfg = await readConfig();
  if (cfg.activeProfile === oldName) {
    const p = await loadProfile(newName);
    await writeConfig({ domain: p?.site ?? cfg.domain, activeProfile: newName });
  }
  jsonResult({ renamed: true, old_name: oldName, new_name: newName });
  humanLog(`  \x1b[32m✓\x1b[0m Renamed profile "${oldName}" → "${newName}"`);
}
