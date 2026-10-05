/**
 * Isolated CLI profile / resolution / safety-gate tests — NO credentials, NO network.
 *
 * Unlike `src/tests/live/profiles.test.ts` (which spawns real subprocesses against a
 * live Chargebee site and skips without `CB_TEST_*`), this suite runs the real
 * Commander program in-process against a fake SDK client. It therefore runs on
 * every PR — including forks — and closes the "skipped = unverified" gap for the
 * credential-resolution flow and the read-only / catalog gates.
 *
 * The fake client (see `src/lib/test-support/_helpers.ts`) records the resolved site/apiKey for each
 * call and returns canned responses whose ids embed the site, so we can assert
 * exactly which site a command actually targeted.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeConfig } from "../../lib/config/store.js";
import { __setClientFactory } from "../../lib/api/sdk.js";

import {
  createEnvPatcher,
  installFakeClient,
  uninstallFakeClient,
  runCli,
  setStdinIsTTY,
  type ClientConstruction,
  type FakeCatalog,
} from "../../lib/test-support/_helpers.js";

// Two test sites on different catalogs, plus one live site for the write gate.
const SITE_V2 = "acme-test"; // PC2 / items
const KEY_V2 = "test_key_v2";
const SITE_V1 = "globex-test"; // PC1 / plans_addons
const KEY_V1 = "test_key_v1";
const SITE_LIVE = "acme"; // live (no -test suffix)
const KEY_LIVE = "live_key";
const SITE_DUAL = "hybrid-test"; // v1 + compat = dual-mode
const KEY_DUAL = "test_key_dual";
const SITE_V2_COMPAT = "upgraded-test"; // v2 + compat = PC2-only

const CATALOG: Record<string, FakeCatalog> = {
  [SITE_V2]: { pcv: "v2", schema: "items" },
  [SITE_V1]: { pcv: "v1", schema: "plans_addons" },
  [SITE_LIVE]: { pcv: "v2", schema: "items" },
  [SITE_DUAL]: { pcv: "v1", schema: "compat" },
  [SITE_V2_COMPAT]: { pcv: "v2", schema: "compat" },
};

let configDir: string;
let constructions: ClientConstruction[];
const env = createEnvPatcher();

/** Configure a profile non-interactively (verifies via the fake catalog call). */
async function configureProfile(profile: string, site: string, apiKey: string) {
  return runCli([
    "auth", "add",
    "--profile",
    profile,
    "--site",
    site,
    "--api-key",
    apiKey,
  ]);
}

/** The site the most recent fake client was constructed with. */
function lastSite(): string | undefined {
  return constructions.at(-1)?.site;
}

/** The hostSuffix the most recent fake client was constructed with. */
function lastHost(): string | undefined {
  return constructions.at(-1)?.hostSuffix;
}

let restoreStdin: (() => void) | undefined;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "cb-cli-"));
  env.set("CHARGEBEE_CONFIG_DIR", configDir);
  env.set("CHARGEBEE_SITE", undefined);
  env.set("CHARGEBEE_API_KEY", undefined);
  env.set("CHARGEBEE_ENV", undefined);
  env.set("CHARGEBEE_HOST", undefined);
  constructions = [];
  installFakeClient({ constructions, catalogBySite: CATALOG });
  // This file is non-interactive. A developer TTY would otherwise hang on
  // `auth remove` without `--yes` (Clack confirm) until the test timeout.
  restoreStdin = setStdinIsTTY(false);
});

afterEach(() => {
  restoreStdin?.();
  uninstallFakeClient();
  env.restore();
  rmSync(configDir, { recursive: true, force: true });
});

describe("configure + resolution", () => {
  it("configure saves a profile and detects its catalog", async () => {
    const { stdout, exitCode } = await configureProfile("dev", SITE_V2, KEY_V2);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("dev");
    expect(stdout).toContain(SITE_V2);

    const list = await runCli(["auth", "list"]);
    expect(list.stdout).toContain("dev");
    expect(list.stdout).toContain(SITE_V2);
    expect(list.stdout).toContain("v2");
    expect(list.stdout).toContain("MODE");
    expect(list.stdout).toContain("test_…");
    expect(list.stdout).not.toContain("test_key");
    expect(list.stdout).not.toContain(KEY_V2);
  });

  it("flagged configure does not print the ASCII splash (scripts stay quiet)", async () => {
    const { stdout, stderr, exitCode } = await configureProfile(
      "dev",
      SITE_V2,
      KEY_V2,
    );
    expect(exitCode).toBe(0);
    const combined = `${stdout}\n${stderr}`;
    expect(combined).not.toContain("____ _   _    _    ____");
    expect(combined).not.toContain("Welcome to Chargebee CLI — let's connect your site.");
  });

  it("the most recently configured profile becomes active and is used for API calls", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    await configureProfile("prod", SITE_V1, KEY_V1);

    const { stdout, exitCode } = await runCli(["customer", "list"]);
    expect(exitCode).toBe(0);
    expect(lastSite()).toBe(SITE_V1);
    const data = JSON.parse(stdout);
    expect(data.list[0].customer.id).toBe(`cus_${SITE_V1}`);
  });
});

describe("profile switching", () => {
  beforeEach(async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    await configureProfile("prod", SITE_V1, KEY_V1);
  });

  it("`auth switch dev` routes API calls to site 1", async () => {
    await runCli(["auth", "switch", "dev"]);
    const { stdout } = await runCli(["auth", "status"]);
    expect(stdout).toContain(SITE_V2);

    const list = await runCli(["customer", "list"]);
    expect(lastSite()).toBe(SITE_V2);
    expect(JSON.parse(list.stdout).list[0].customer.id).toBe(`cus_${SITE_V2}`);
  });

  it("`auth switch prod` switches the active site to site 2", async () => {
    await runCli(["auth", "switch", "dev"]);
    const { exitCode } = await runCli(["auth", "switch", "prod"]);
    expect(exitCode).toBe(0);
    const { stdout } = await runCli(["auth", "status"]);
    expect(stdout).toContain(SITE_V1);
  });

  it("auth switch rejects an invalid profile name", async () => {
    const { stderr, exitCode } = await runCli(["auth", "switch", "bad name"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid profile name");
  });

  it("auth switch errors when the named profile is missing", async () => {
    const { stderr, exitCode } = await runCli(["auth", "switch", "ghost"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('Profile "ghost" not found');
  });
});

describe("auth remove edge cases", () => {
  it("errors when there are no saved profiles", async () => {
    const { stderr, exitCode } = await runCli(["auth", "remove", "ghost", "--yes"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("No saved profiles to remove");
  });

  it("requires a profile name in a non-interactive shell", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    const { stderr, exitCode } = await runCli(["auth", "remove", "--yes"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Profile name required");
  });

  it("rejects an invalid name", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    const { stderr, exitCode } = await runCli(["auth", "remove", "bad name", "--yes"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid profile name");
  });
});

describe("flagged configure validation", () => {
  it("rejects an invalid --profile name before contacting the API", async () => {
    const { stderr, exitCode } = await runCli([
      "auth", "add",
      "--profile",
      "bad name",
      "--site",
      SITE_V2,
      "--api-key",
      KEY_V2,
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Invalid profile name");
  });
});

describe("--use-profile per-command override", () => {
  beforeEach(async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    await configureProfile("prod", SITE_V1, KEY_V1);
    await runCli(["auth", "switch", "dev"]); // active = dev (site 1)
  });

  it("--use-profile prod hits site 2 without changing the active profile", async () => {
    const { stdout, exitCode } = await runCli([
      "--use-profile",
      "prod",
      "customer",
      "list",
    ]);
    expect(exitCode).toBe(0);
    expect(lastSite()).toBe(SITE_V1);
    expect(JSON.parse(stdout).list[0].customer.id).toBe(`cus_${SITE_V1}`);

    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain(SITE_V2); // active unchanged
  });

  it("open honors --use-profile without changing the active profile", async () => {
    const { stdout, exitCode } = await runCli([
      "--use-profile",
      "prod",
      "open",
      "customers",
      "--url-only",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`https://${SITE_V1}.chargebee.com/customers`);

    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain(SITE_V2); // active unchanged
  });

  it("unknown --use-profile fails clearly", async () => {
    const { stderr, exitCode } = await runCli([
      "--use-profile",
      "ghost",
      "customer",
      "list",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("ghost");
  });

  it("rejects --use-profile on auth status", async () => {
    const { stderr, exitCode } = await runCli([
      "--use-profile",
      "prod",
      "auth", "status",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(
      "--use-profile is only valid for API commands, open, and listen",
    );
    expect(stderr).toContain("auth switch prod");

    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain(SITE_V2); // active unchanged
  });

  it("rejects --use-profile on docs and skills", async () => {
    const docs = await runCli(["--use-profile", "prod", "docs"]);
    expect(docs.exitCode).not.toBe(0);
    expect(docs.stderr).toContain("--use-profile is only valid");

    const skills = await runCli(["--use-profile", "prod", "skills", "list"]);
    expect(skills.exitCode).not.toBe(0);
    expect(skills.stderr).toContain("--use-profile is only valid");
  });

  it("rejects --use-profile on whoami", async () => {
    const { stderr, exitCode } = await runCli([
      "--use-profile",
      "prod",
      "whoami",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--use-profile is only valid");
  });

  it("allows --use-profile on listen --help", async () => {
    const { exitCode, stderr } = await runCli([
      "--use-profile",
      "prod",
      "listen",
      "--help",
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("--use-profile is only valid");
  });
});

describe("env-var precedence", () => {
  it("env vars override the active stored profile", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2); // active = site 1
    env.set("CHARGEBEE_SITE", SITE_V1);
    env.set("CHARGEBEE_API_KEY", KEY_V1);

    const { stdout, exitCode } = await runCli(["auth", "status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(SITE_V1);
    expect(stdout).toContain("environment variables");

    const list = await runCli(["customer", "list"]);
    expect(lastSite()).toBe(SITE_V1);
  });

  it("fails clearly when only CHARGEBEE_SITE is set", async () => {
    env.set("CHARGEBEE_SITE", SITE_V2);
    const { stderr, exitCode } = await runCli(["customer", "list"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("CHARGEBEE_API_KEY");
  });

  it("fails clearly when nothing is configured", async () => {
    const { stderr, exitCode } = await runCli(["customer", "list"]);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toMatch(/not configured|chargebee auth add/);
  });
});

describe("site name validation (host allowlist)", () => {
  const HOSTILE = ["evil.com?", "evil.com#", "evil.com/", "user@evil.com"];

  for (const site of HOSTILE) {
    it(`auth add --site '${site}' exits 1 before any client is built`, async () => {
      const { stderr, exitCode } = await runCli([
        "auth", "add",
        "--site",
        site,
        "--api-key",
        "test_x",
      ]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`Invalid site name '${site}'. Use only the subdomain, e.g. acme-test.`);
      expect(constructions).toHaveLength(0);
      expect(existsSync(join(configDir, "profiles", "default.json"))).toBe(false);
    });
  }

  for (const site of HOSTILE) {
    it(`CHARGEBEE_SITE='${site}' is rejected before any client is built`, async () => {
      env.set("CHARGEBEE_SITE", site);
      env.set("CHARGEBEE_API_KEY", "test_x");
      const { stderr, exitCode } = await runCli(["customer", "list"]);
      expect(exitCode).toBe(1);
      expect(stderr).toContain(`Invalid site name '${site}'`);
      expect(constructions).toHaveLength(0);
    });
  }

  it("normalises CHARGEBEE_SITE=acme-test.chargebee.com to the bare site", async () => {
    env.set("CHARGEBEE_SITE", "acme-test.chargebee.com");
    env.set("CHARGEBEE_API_KEY", KEY_V2);
    const { exitCode } = await runCli(["customer", "list"]);
    expect(exitCode).toBe(0);
    expect(lastSite()).toBe(SITE_V2);
    expect(lastHost()).toBe(".chargebee.com");
  });

  it("lower-cases a mixed-case CHARGEBEE_SITE", async () => {
    env.set("CHARGEBEE_SITE", "ACME-Test");
    env.set("CHARGEBEE_API_KEY", KEY_V2);
    const { exitCode } = await runCli(["customer", "list"]);
    expect(exitCode).toBe(0);
    expect(lastSite()).toBe(SITE_V2);
  });

  it("rejects a hostile site stored in a profile file", async () => {
    mkdirSync(join(configDir, "profiles"), { recursive: true });
    writeFileSync(
      join(configDir, "profiles", "bad.json"),
      JSON.stringify({ site: "evil.com#", api_key: "test_x" }),
    );
    await writeConfig({ domain: "evil.com#", activeProfile: "bad" });
    const list = await runCli(["customer", "list"]);
    expect(list.exitCode).toBe(1);
    expect(list.stderr).toContain("Invalid site name 'evil.com#'");
    expect(constructions).toHaveLength(0);

    const status = await runCli(["auth", "status"]);
    expect(status.exitCode).toBe(1);
    expect(status.stdout).not.toContain("Connected");
    expect(status.stderr).toContain("Invalid site name 'evil.com#'");
  });
});

describe("read-only write gate", () => {
  it("blocks a write on a live site", async () => {
    await configureProfile("live", SITE_LIVE, KEY_LIVE);
    const { stderr, exitCode } = await runCli([
      "customer",
      "create",
      "-d",
      "email=a@b.com",
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain("live site");
  });

  it("allows a write on a test site", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    const { stdout, exitCode } = await runCli([
      "customer",
      "create",
      "-d",
      "email=a@b.com",
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).customer.id).toBe(`cus_new_${SITE_V2}`);
  });

  it("allows reads on a live site", async () => {
    await configureProfile("live", SITE_LIVE, KEY_LIVE);
    const { exitCode } = await runCli(["customer", "list"]);
    expect(exitCode).toBe(0);
    expect(lastSite()).toBe(SITE_LIVE);
  });
});

describe("catalog gate", () => {
  it("blocks a PC2-only op on a PC1 site", async () => {
    await configureProfile("prod", SITE_V1, KEY_V1); // PC1 site
    const { stderr, exitCode } = await runCli(["item", "list"]);
    expect(exitCode).toBe(6);
    expect(stderr.toLowerCase()).toContain("isn't available");
  });

  it("blocks a PC1-only op on a PC2 site", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2); // PC2 site
    const { stderr, exitCode } = await runCli(["plan", "list"]);
    expect(exitCode).toBe(6);
    expect(stderr.toLowerCase()).toContain("isn't available");
  });

  it("allows the matching catalog op (PC1 op on PC1 site)", async () => {
    await configureProfile("prod", SITE_V1, KEY_V1);
    const { stdout, exitCode } = await runCli(["plan", "list"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).list[0].plan.id).toBe(`plan_${SITE_V1}`);
  });

  it("allows the matching catalog op (PC2 op on PC2 site)", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    const { stdout, exitCode } = await runCli(["item", "list"]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).list[0].item.id).toBe(`item_${SITE_V2}`);
  });

  it("allows both catalogs on a dual-mode site (v1 + compat)", async () => {
    await configureProfile("dual", SITE_DUAL, KEY_DUAL);
    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain("dual-mode");
    const pc1 = await runCli(["plan", "list"]);
    expect(pc1.exitCode).toBe(0);
    const pc2 = await runCli(["item", "list"]);
    expect(pc2.exitCode).toBe(0);
  });

  it("treats v2 + compat as PC2-only, not dual-mode", async () => {
    await configureProfile("upgraded", SITE_V2_COMPAT, KEY_V2);
    const blocked = await runCli(["plan", "list"]);
    expect(blocked.exitCode).toBe(6);
    expect(blocked.stderr.toLowerCase()).toContain("isn't available");
    const allowed = await runCli(["item", "list"]);
    expect(allowed.exitCode).toBe(0);
  });
});

describe("auth remove", () => {
  it("removes a named profile with --yes", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    await configureProfile("prod", SITE_V1, KEY_V1);

    const { stdout, exitCode } = await runCli([
      "auth", "remove",
      "dev",
      "--yes",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Removed");

    const list = await runCli(["auth", "list"]);
    expect(list.stdout).not.toContain("dev");
    expect(list.stdout).toContain("prod");
  });

  it("disconnects when the removed profile is active and it was the only one", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2); // active

    const { exitCode } = await runCli(["auth", "remove", "dev", "--yes"]);
    expect(exitCode).toBe(0);

    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain("Not configured");
  });

  it("fails clearly for an unknown profile", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    const { stderr, exitCode } = await runCli([
      "auth", "remove",
      "ghost",
      "--yes",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("ghost");
  });

  it("refuses to remove without --yes in a non-interactive shell", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    const { stderr, exitCode } = await runCli(["auth", "remove", "dev"]);
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain("--yes");
    // Profile is still present.
    const list = await runCli(["auth", "list"]);
    expect(list.stdout).toContain("dev");
  });

  it("auth remove deletes a profile", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    const { exitCode } = await runCli(["auth", "remove", "dev", "--yes"]);
    expect(exitCode).toBe(0);
    const list = await runCli(["auth", "list"]);
    expect(list.stdout).not.toContain("dev");
  });
});

describe("auth rename", () => {
  it("renames a profile and preserves its data", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    const { exitCode } = await runCli([
      "auth", "rename",
      "dev",
      "staging",
    ]);
    expect(exitCode).toBe(0);

    const list = await runCli(["auth", "list"]);
    expect(list.stdout).toContain("staging");
    expect(list.stdout).not.toContain("dev");
  });

  it("moves the active pointer when renaming the active profile", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2); // active
    await runCli(["auth", "rename", "dev", "staging"]);

    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain(SITE_V2);
    expect(status.stdout).toContain("staging");

    // API calls still route correctly through the renamed profile.
    const list = await runCli(["customer", "list"]);
    expect(lastSite()).toBe(SITE_V2);
  });

  it("fails when the destination already exists", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    await configureProfile("prod", SITE_V1, KEY_V1);
    const { stderr, exitCode } = await runCli([
      "auth", "rename",
      "dev",
      "prod",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("already exists");
  });

  it("fails when the source is missing", async () => {
    const { stderr, exitCode } = await runCli([
      "auth", "rename",
      "ghost",
      "new",
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("not found");
  });
});

describe("auth list / status / aliases", () => {
  it("status includes test vs live mode", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    const { stdout, exitCode } = await runCli(["auth", "status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Mode        : test");
    expect(stdout).toContain(SITE_V2);
  });

  it("status marks a live site as live", async () => {
    await configureProfile("live", SITE_LIVE, KEY_LIVE);
    const { stdout } = await runCli(["auth", "status"]);
    expect(stdout).toContain("Mode        : live");
  });

  it("auth status and list share saved profiles", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    const viaAuth = await runCli(["auth", "status"]);
    expect(viaAuth.exitCode).toBe(0);
    expect(viaAuth.stdout).toContain(SITE_V2);

    const list = await runCli(["auth", "list"]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain("dev");
  });

  it("root help lists use and --use-profile", async () => {
    const { stdout, exitCode } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("use");
    expect(stdout).toContain("--use-profile");
  });

  it("auth list shows live mode without leaking the key", async () => {
    await configureProfile("live", SITE_LIVE, KEY_LIVE);
    const { stdout } = await runCli(["auth", "list"]);
    expect(stdout).toContain("HOST");
    expect(stdout).toContain("REGION");
    expect(stdout).toContain("live_…");
    expect(stdout).not.toContain(KEY_LIVE);
    expect(stdout).toMatch(/us\s+chargebee\.com\s+\S+\s+live\s+file\s+live_…/);
  });
});

describe("--code-sample generation", () => {
  // Samples use the bundled generator + public specs (no API call). Catalog-
  // exclusive ops use the same PCV+schema gate as a real call; unconfigured
  // and `--code-sample list` fail open.

  it("emits a curl sample for `customer create --code-sample curl` (unconfigured)", async () => {
    const { stdout, exitCode } = await runCli([
      "customer",
      "create",
      "--code-sample",
      "curl",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain("curl");
    expect(stdout).toContain("customers");
  });

  it("generates a subscription sample from indexed Chargebee form fields without an API call", async () => {
    const { stdout, stderr, exitCode } = await runCli([
      "subscription", "create-with-items", "cus_demo", "--code-sample", "curl",
      "-d", "subscription_items[item_price_id][0]=basic-USD",
      "-d", "subscription_items[billing_cycles][0]=2",
      "-d", "subscription_items[quantity][0]=1",
      "-d", "subscription_items[item_price_id][1]=day-pass-USD",
      "-d", "subscription_items[unit_price][1]=100",
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("/customers/cus_demo/subscription_for_items");
    expect(stdout).toContain('"subscription_items[item_price_id][0]"="basic-USD"');
    expect(stdout).toContain('"subscription_items[billing_cycles][0]"=2');
    expect(stdout).toContain('"subscription_items[quantity][0]"=1');
    expect(stdout).toContain('"subscription_items[item_price_id][1]"="day-pass-USD"');
    expect(stdout).toContain('"subscription_items[unit_price][1]"=100');
    expect(constructions).toHaveLength(0);
  });

  it("fails open on a catalog-exclusive sample when unconfigured", async () => {
    const { stdout, exitCode } = await runCli([
      "plan",
      "create",
      "-d",
      "id=basic",
      "-d",
      "name=Basic",
      "--code-sample",
      "go",
      "--pc-version",
      "v1",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it.each([
    ["eamil", "Expected a non-empty key=value pair"],
    ["eamil=ada@example.com", 'Unknown field "eamil"'],
  ])("rejects invalid sample input %s with clean stderr", async (data, message) => {
    const { stdout, stderr, exitCode } = await runCli([
      "customer", "create", "-d", data, "--code-sample", "python",
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(message);
    expect(constructions).toHaveLength(0);
  });

  it("reports required sample parameters instead of generating incomplete code", async () => {
    const { stdout, stderr, exitCode } = await runCli([
      "plan", "create", "--code-sample", "go", "--pc-version", "v1",
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain('Required field "id" is missing');
    expect(constructions).toHaveLength(0);
  });

  it.each(["create", "list"])("rejects malformed data before the SDK %s operation", async (operation) => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    let called = false;
    __setClientFactory(() => ({
      customer: {
        [operation]: async () => {
          called = true;
          return {};
        },
      },
    }) as never);
    const { stdout, stderr, exitCode } = await runCli([
      "customer", operation, "-d", "eamil",
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Expected a non-empty key=value pair");
    expect(called).toBe(false);
  });

  it("blocks a PC2-only sample on a PC1 site", async () => {
    await configureProfile("prod", SITE_V1, KEY_V1);
    const { stderr, exitCode } = await runCli([
      "item",
      "list",
      "--code-sample",
      "python",
    ]);
    expect(exitCode).toBe(6);
    expect(stderr.toLowerCase()).toContain("isn't available");
  });

  it("blocks a PC1-only sample on a PC2 site", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    const { stderr, exitCode } = await runCli([
      "plan",
      "list",
      "--code-sample",
      "go",
    ]);
    expect(exitCode).toBe(6);
    expect(stderr.toLowerCase()).toContain("isn't available");
  });

  it("does not let --pc-version punch through a catalog mismatch", async () => {
    await configureProfile("prod", SITE_V1, KEY_V1);
    const { stderr, exitCode } = await runCli([
      "item",
      "list",
      "--code-sample",
      "python",
      "--pc-version",
      "v2",
    ]);
    expect(exitCode).toBe(6);
    expect(stderr.toLowerCase()).toContain("isn't available");
  });

  it("allows both catalogs on a dual-mode site (v1 + compat)", async () => {
    await configureProfile("dual", SITE_DUAL, KEY_DUAL);
    const pc1 = await runCli([
      "plan",
      "list",
      "--code-sample",
      "go",
      "--pc-version",
      "v1",
    ]);
    expect(pc1.exitCode).toBe(0);
    expect(pc1.stdout.length).toBeGreaterThan(0);
    const pc2 = await runCli([
      "item",
      "list",
      "--code-sample",
      "python",
      "--pc-version",
      "v2",
    ]);
    expect(pc2.exitCode).toBe(0);
    expect(pc2.stdout.length).toBeGreaterThan(0);
  });

  it("blocks a PC1 sample on v2 + compat (not dual-mode)", async () => {
    await configureProfile("upgraded", SITE_V2_COMPAT, KEY_V2);
    const { stderr, exitCode } = await runCli([
      "plan",
      "list",
      "--code-sample",
      "go",
      "--pc-version",
      "v1",
    ]);
    expect(exitCode).toBe(6);
    expect(stderr.toLowerCase()).toContain("isn't available");
  });

  it("does not gate --code-sample list on a catalog-mismatched op", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    const { stdout, exitCode } = await runCli([
      "plan",
      "list",
      "--code-sample",
      "list",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain("supported languages");
  });

  it("skips the live-site write gate for samples", async () => {
    await configureProfile("live", SITE_LIVE, KEY_LIVE);
    const { stdout, exitCode } = await runCli([
      "customer",
      "create",
      "--code-sample",
      "curl",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain("curl");
  });

  it("`--code-sample list` prints the supported languages", async () => {
    const { stdout, exitCode } = await runCli([
      "customer",
      "create",
      "--code-sample",
      "list",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).toContain("supported languages");
    expect(stdout).toContain("curl");
    expect(stdout).toMatch(/^ {2}python\b/m);
    expect(stdout).toContain("nodejs");
    expect(stdout).toContain("aliases:");
    expect(stdout).toContain("go-v4");
  });

  it("accepts friendly --code-sample language aliases", async () => {
    const { stdout, exitCode } = await runCli([
      "customer",
      "create",
      "--code-sample",
      "python",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("from chargebee import Chargebee");
  });

  it("invalid --code-sample language fails with a clean CLI error", async () => {
    const { stderr, exitCode } = await runCli([
      "customer",
      "list",
      "--code-sample",
      "nodfd",
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unsupported code sample language: nodfd");
    expect(stderr).toContain(
      "Supported languages: curl, python, nodejs, go, java, php, ruby, dotnet",
    );
    expect(stderr).not.toContain("python-v3");
    expect(stderr).not.toContain("LanguageNotSupportedError");
    expect(stderr).not.toContain(" at ");
  });
});

describe("API host on configure / status", () => {
  it("auth add --host persists on the profile", async () => {
    const { stdout, exitCode } = await runCli([
      "auth", "add",
      "--profile",
      "dev",
      "--site",
      SITE_V2,
      "--api-key",
      KEY_V2,
      "--host",
      "example.com",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("example.com");

    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain("example.com");
    expect(status.stdout).toContain(`https://${SITE_V2}.example.com`);

    await runCli(["customer", "list"]);
    expect(lastHost()).toBe(".example.com");
  });

  it("extracts host from a full --site URL", async () => {
    const { exitCode } = await runCli([
      "auth", "add",
      "--profile",
      "dev",
      "--site",
      `https://${SITE_V2}.chargebee.com`,
      "--api-key",
      KEY_V2,
    ]);
    expect(exitCode).toBe(0);
    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain(SITE_V2);
    expect(status.stdout).toContain("chargebee.com");
    expect(status.stdout).toContain(`https://${SITE_V2}.chargebee.com`);
  });
});

describe("unknown command errors", () => {
  it("unknown command is a clean error with a --help hint", async () => {
    const { stderr, exitCode } = await runCli(["foobarbaz"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown command");
    expect(stderr).toContain("foobarbaz");
    expect(stderr).toContain("--help");
    expect(stderr).not.toContain(" at ");
    expect(stderr).not.toContain("Bun v");
  });

  it("unknown resource action suggests --help without a stack", async () => {
    const { stderr, exitCode } = await runCli(["customer", "foobarbaz"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown command");
    expect(stderr).toContain("--help");
    expect(stderr).not.toContain(" at ");
  });
});
