/**
 * Interactive configure / use / remove — mocked Clack, fake SDK, no TTY wait.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeConfig } from "../../lib/config/store.js";
import {
  __resetPromptsForTest,
  __setPromptsForTest,
} from "../../lib/prompts.js";
import { __resetInteractiveForTest } from "../../lib/telemetry/interactive.js";
import {
  createEnvPatcher,
  installFakeClient,
  runCli,
  setStderrIsTTY,
  setStdinIsTTY,
  setStdoutIsTTY,
  uninstallFakeClient,
  type ClientConstruction,
} from "../../lib/test-support/_helpers.js";

const SITE_V2 = "acme-test";
const KEY_V2 = "test_key_v2";
const SITE_V1 = "globex-test";
const KEY_V1 = "test_key_v1";
const CANCEL = Symbol("clack-cancel");

const CATALOG = {
  [SITE_V2]: { pcv: "v2", schema: "items" },
  [SITE_V1]: { pcv: "v1", schema: "plans_addons" },
};

let configDir: string;
let constructions: ClientConstruction[];
const env = createEnvPatcher();

function noopSpinner() {
  return { start() {}, stop() {} };
}

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

/** Raw profile JSON, to assert what is (and is not) persisted. */
function profileOnDisk(name: string): { region?: string; host?: string } {
  return JSON.parse(readFileSync(join(configDir, "profiles", `${name}.json`), "utf-8"));
}

type PromptOpts = {
  message?: string;
  validate?: (value: string | undefined) => string | undefined;
};

type SelectOpts = {
  message?: string;
  initialValue?: string;
  options?: Array<{ value: string; label: string; hint?: string }>;
};

/** Run Clack validators so auth.ts callback coverage is not TTY-gated. */
function exerciseValidate(opts: PromptOpts, values: Array<string | undefined>): void {
  const validate = opts.validate;
  if (!validate) return;
  for (const value of values) validate(value);
}

/** Dispatch Clack `text` by prompt so site and profile answers stay independent. */
function configureText(site: unknown = SITE_V2, profile: unknown = "") {
  return async (opts: PromptOpts) => {
    const msg = String(opts.message ?? "");
    if (/profile/i.test(msg)) {
      exerciseValidate(opts, [undefined, "", "   ", "bad name", "CON", "staging"]);
      return profile;
    }
    exerciseValidate(opts, [undefined, "", "evil.com#", SITE_V2]);
    return site;
  };
}

function configurePassword(key: unknown = KEY_V2) {
  return async (opts: PromptOpts) => {
    exerciseValidate(opts, [undefined, "", "   ", KEY_V2]);
    return key;
  };
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "cb-cfg-interactive-"));
  env.set("CHARGEBEE_CONFIG_DIR", configDir);
  env.set("CHARGEBEE_SITE", undefined);
  env.set("CHARGEBEE_API_KEY", undefined);
  constructions = [];
  installFakeClient({ constructions, catalogBySite: CATALOG });
  __setPromptsForTest({
    isCancel: (v) => v === CANCEL,
    cancel: () => undefined,
    spinner: noopSpinner,
    intro: () => undefined,
    confirm: async () => false,
    // Interactive configure opens a region `select` before anything else;
    // without a stub the real Clack prompt would wait forever on the fake TTY.
    select: async () => "us",
  });
  setStdinIsTTY(false);
});

afterEach(() => {
  __resetPromptsForTest();
  __resetInteractiveForTest();
  // Never leave stdin as a TTY — later isolated CLI tests would hang on Clack.
  setStdinIsTTY(false);
  uninstallFakeClient();
  env.restore();
  rmSync(configDir, { recursive: true, force: true });
});

describe("interactive auth add", () => {
  // Prompts only open on a real terminal; pin both streams so the guard passes.
  let restoreStdout: () => void;
  beforeEach(() => {
    setStdinIsTTY(true);
    restoreStdout = setStdoutIsTTY(true);
  });
  afterEach(() => {
    restoreStdout();
    setStdinIsTTY(false);
  });

  it("saves production when the active profile and CHARGEBEE_HOST name another host", async () => {
    mkdirSync(join(configDir, "profiles"), { recursive: true });
    writeFileSync(
      join(configDir, "profiles", "dev.json"),
      JSON.stringify({ site: "other-test", api_key: "test_other", host: "example.com" }),
    );
    await writeConfig({ domain: "other-test", activeProfile: "dev" });
    env.set("CHARGEBEE_HOST", "example.com");
    __setPromptsForTest({
      text: configureText(SITE_V2, "dev-20-test"),
      password: configurePassword(),
    });
    const { exitCode } = await runCli(["auth", "add"]);
    expect(exitCode).toBe(0);
    expect(profileOnDisk("dev-20-test").host).toBeUndefined();
    expect(constructions.at(-1)?.hostSuffix).toBe(".chargebee.com");
    const listed = await runCli(["auth", "list"]);
    expect(listed.stdout).toMatch(/dev-20-test\s+\S+\s+us\s+chargebee\.com\s+/);
    expect(listed.stdout).toMatch(/dev\s+\S+\s+us\s+example\.com\s+/);
  });

  it("prompts for site and key, then saves the default profile", async () => {
    __setPromptsForTest({
      text: configureText(),
      password: configurePassword(),
    });
    const { stdout, exitCode } = await runCli(["auth", "add"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Connected");
    expect(stdout).toContain(SITE_V2);
    expect(stdout).toContain("profile: default");
    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain(SITE_V2);
    expect(status.stdout).toContain("profile: default");
  });

  it("asks for the region first, then site, key and profile", async () => {
    const asked: string[] = [];
    __setPromptsForTest({
      select: async () => {
        asked.push("region");
        return "eu";
      },
      text: async (opts: PromptOpts) => {
        const msg = String(opts.message ?? "");
        const isProfile = /profile/i.test(msg);
        asked.push(isProfile ? "profile" : "site");
        return isProfile ? "" : SITE_V2;
      },
      password: async () => {
        asked.push("key");
        return KEY_V2;
      },
    });
    const { stdout, exitCode } = await runCli(["auth", "add"]);
    expect(exitCode).toBe(0);
    expect(asked).toEqual(["region", "site", "key", "profile"]);
    expect(stdout).toContain("Region  : eu");
    expect(profileOnDisk("default").region).toBe("eu");
  });

  it("labels the region prompt and marks the default without nesting parentheses", async () => {
    let opts: SelectOpts | undefined;
    __setPromptsForTest({
      select: async (o: SelectOpts) => {
        opts = o;
        return "us";
      },
      text: configureText(),
      password: configurePassword(),
    });
    const { exitCode } = await runCli(["auth", "add"]);
    expect(exitCode).toBe(0);
    expect(opts?.message).toBe("Your site's region");
    expect(opts?.initialValue).toBe("us");
    expect(opts?.options).toEqual([
      { value: "us", label: "us", hint: "United States — default" },
      { value: "eu", label: "eu", hint: "Europe" },
      { value: "au", label: "au", hint: "Australia" },
    ]);
    // Clack renders the hint inside parentheses, so it must not carry its own.
    for (const option of opts?.options ?? []) {
      expect(option.hint).not.toContain("(");
    }
  });

  it("prints the default region but leaves it out of the profile file", async () => {
    __setPromptsForTest({
      select: async () => "us",
      text: configureText(),
      password: configurePassword(),
    });
    const { stdout, exitCode } = await runCli(["auth", "add"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Region  : us");
    expect(profileOnDisk("default").region).toBeUndefined();
  });

  it("skips the region prompt when --region is set", async () => {
    let regionPrompted = false;
    __setPromptsForTest({
      select: async () => {
        regionPrompted = true;
        return "us";
      },
      text: configureText(),
      password: configurePassword(),
    });
    const { stdout, exitCode } = await runCli(["auth", "add", "--region", "au"]);
    expect(exitCode).toBe(0);
    expect(regionPrompted).toBe(false);
    expect(stdout).toContain("Region  : au");
    expect(profileOnDisk("default").region).toBe("au");
  });

  it("cancels when the region prompt is cancelled, before asking for a key", async () => {
    let keyPrompted = false;
    __setPromptsForTest({
      select: async () => CANCEL,
      text: configureText(),
      password: async () => {
        keyPrompted = true;
        return KEY_V2;
      },
    });
    const { stdout, stderr, exitCode } = await runCli(["auth", "add"]);
    expect(exitCode).toBe(0);
    expect(keyPrompted).toBe(false);
    expect(`${stdout}\n${stderr}`).not.toContain("Connected");
    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain("Not configured");
  });

  it("rejects an invalid --region before prompting for anything", async () => {
    let prompted = false;
    __setPromptsForTest({
      select: async () => {
        prompted = true;
        return "us";
      },
      text: async () => {
        prompted = true;
        return SITE_V2;
      },
      password: async () => {
        prompted = true;
        return KEY_V2;
      },
    });
    const { stderr, exitCode } = await runCli(["auth", "add", "--region", "eu-central-1"]);
    expect(exitCode).toBe(1);
    expect(prompted).toBe(false);
    expect(stderr).toContain("Invalid region");
    expect(constructions).toHaveLength(0);
  });

  it("opens the prompt session with a welcome intro and no splash", async () => {
    const restoreStderr = setStderrIsTTY(true);
    const intros: string[] = [];
    try {
      __setPromptsForTest({
        text: configureText(),
        password: configurePassword(),
        intro: (message?: string) => { intros.push(String(message)); },
      });
      const { stdout, stderr, exitCode } = await runCli(["auth", "add"]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Connected");
      expect(intros).toEqual(["Welcome to Chargebee CLI — let's connect your site."]);
      expect(stderr).not.toContain("Build with Chargebee from the terminal");
    } finally {
      restoreStderr();
    }
  });

  it("saves a named profile when the third prompt is filled", async () => {
    __setPromptsForTest({
      text: configureText(SITE_V2, "staging"),
      password: async () => KEY_V2,
    });
    const { stdout, exitCode } = await runCli(["auth", "add"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("profile: staging");
    const list = await runCli(["auth", "list"]);
    expect(list.stdout).toContain("staging");
    expect(list.stdout).toContain(SITE_V2);
    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain("profile: staging");
  });

  it("treats an empty submit (undefined prompt result) as the default profile", async () => {
    __setPromptsForTest({
      // Inline stub: an explicit undefined would hit configureText's default parameter.
      text: async (opts: { message?: string }) =>
        /profile/i.test(String(opts.message ?? "")) ? undefined : SITE_V2,
      password: async () => KEY_V2,
    });
    const { stdout, exitCode } = await runCli(["auth", "add"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("profile: default");
  });

  it("treats a whitespace-only profile name as default", async () => {
    __setPromptsForTest({
      text: configureText(SITE_V2, "   "),
      password: async () => KEY_V2,
    });
    const { stdout, exitCode } = await runCli(["auth", "add"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("profile: default");
  });

  it("skips the profile prompt when --profile is set", async () => {
    let profilePrompted = false;
    __setPromptsForTest({
      text: async (opts: { message?: string }) => {
        if (/profile/i.test(String(opts.message ?? ""))) {
          profilePrompted = true;
          return "should-not-run";
        }
        return SITE_V2;
      },
      password: async () => KEY_V2,
    });
    const { stdout, exitCode } = await runCli([
      "auth", "add",
      "--profile",
      "prod",
    ]);
    expect(exitCode).toBe(0);
    expect(profilePrompted).toBe(false);
    expect(stdout).toContain("profile: prod");
  });

  it("does not prompt for a profile on fully flagged configure", async () => {
    let textCalls = 0;
    __setPromptsForTest({
      text: async () => {
        textCalls += 1;
        return "should-not-run";
      },
      password: async () => "should-not-run",
    });
    const { stdout, exitCode } = await runCli([
      "auth", "add",
      "--site",
      SITE_V2,
      "--api-key",
      KEY_V2,
    ]);
    expect(exitCode).toBe(0);
    expect(textCalls).toBe(0);
    expect(stdout).toContain("profile: default");
  });

  it("cancels when the site prompt is cancelled", async () => {
    __setPromptsForTest({
      text: configureText(CANCEL),
      password: async () => KEY_V2,
    });
    const { exitCode, stdout, stderr } = await runCli(["auth", "add"]);
    expect(exitCode).toBe(0);
    expect(`${stdout}\n${stderr}`).not.toContain("Connected");
    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain("Not configured");
  });

  it("cancels when the API key prompt is cancelled", async () => {
    __setPromptsForTest({
      text: configureText(),
      password: async () => CANCEL,
    });
    const { stdout, stderr } = await runCli(["auth", "add"]);
    expect(`${stdout}\n${stderr}`).not.toContain("Connected");
  });

  it("cancels when the profile prompt is cancelled", async () => {
    __setPromptsForTest({
      text: configureText(SITE_V2, CANCEL),
      password: async () => KEY_V2,
    });
    const { stdout, stderr } = await runCli(["auth", "add"]);
    expect(`${stdout}\n${stderr}`).not.toContain("Connected");
    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain("Not configured");
  });

  it("exits when credential verification fails", async () => {
    installFakeClient({ constructions, catalogBySite: CATALOG });
    const { __setClientFactory } = await import("../../lib/api/sdk.js");
    __setClientFactory(
      () =>
        ({
          configuration: {
            list: async () => {
              throw { http_status_code: 401, message: "unauthorized" };
            },
          },
        }) as never,
    );
    __setPromptsForTest({
      text: configureText(),
      password: async () => "bad_key",
    });
    const { exitCode, stderr } = await runCli(["auth", "add"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid API key");
  });
});

describe("auth status edges", () => {
  it("human output says not configured when nothing is saved", async () => {
    const { stdout, exitCode } = await runCli(["auth", "status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Not configured");
  });

  it("errors when only one env var is set", async () => {
    env.set("CHARGEBEE_SITE", SITE_V2);
    const { stderr, exitCode } = await runCli(["auth", "status"]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain("CHARGEBEE_API_KEY");
  });

  it("errors when the active profile file is missing", async () => {
    await writeConfig({ domain: SITE_V2, activeProfile: "ghost" });
    const { stderr, exitCode } = await runCli(["auth", "status"]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('Active profile "ghost" not found');
  });

  it("human status prints the PC1 catalog label", async () => {
    await configureProfile("dev", SITE_V1, KEY_V1);
    const { stdout, exitCode } = await runCli(["auth", "status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Product Catalog 1.0");
    expect(stdout).toContain(SITE_V1);
    expect(stdout).not.toContain("dual-mode");
  });
});

describe("configure notes when saving env-var credentials", () => {
  it("prints a notice when both CHARGEBEE_SITE and CHARGEBEE_API_KEY come from the environment", async () => {
    env.set("CHARGEBEE_SITE", SITE_V2);
    env.set("CHARGEBEE_API_KEY", KEY_V2);
    const { stdout, exitCode } = await runCli(["auth", "add"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Saving CHARGEBEE_SITE/CHARGEBEE_API_KEY from the environment as profile default.");
  });

  it("does not print the notice when site and key come from flags", async () => {
    const { stdout, exitCode } = await configureProfile("dev", SITE_V2, KEY_V2);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("from the environment");
  });
});

describe("configure region without a terminal", () => {
  it("defaults to us when --region is omitted on a fully flagged run", async () => {
    const { stdout, exitCode } = await configureProfile("dev", SITE_V2, KEY_V2);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Region  : us");
    expect(profileOnDisk("dev").region).toBeUndefined();
  });

  it("saves --region on a fully flagged run", async () => {
    const { stdout, exitCode } = await runCli([
      "auth", "add",
      "--profile",
      "dev",
      "--site",
      SITE_V2,
      "--api-key",
      KEY_V2,
      "--region",
      "au",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Region  : au");
    expect(profileOnDisk("dev").region).toBe("au");
  });

  it("accepts a region in any case", async () => {
    const { stdout, exitCode } = await runCli([
      "auth", "add",
      "--profile",
      "dev",
      "--site",
      SITE_V2,
      "--api-key",
      KEY_V2,
      "--region",
      "EU",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Region  : eu");
    expect(profileOnDisk("dev").region).toBe("eu");
  });

  it("status reports the saved region", async () => {
    await runCli([
      "auth", "add",
      "--profile",
      "dev",
      "--site",
      SITE_V2,
      "--api-key",
      KEY_V2,
      "--region",
      "eu",
    ]);
    const { stdout } = await runCli(["auth", "status"]);
    expect(stdout).toContain("Region      : eu");
  });

  it("status omits the region rather than failing when the saved value is invalid", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    const path = join(configDir, "profiles", "dev.json");
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...raw, region: "uk" }));
    const { stdout, exitCode } = await runCli(["auth", "status"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(SITE_V2);
    expect(stdout).not.toContain("Region      :");
  });

  it("list shows the region column for every profile", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    await runCli([
      "auth", "add",
      "--profile",
      "eu-prof",
      "--site",
      SITE_V1,
      "--api-key",
      KEY_V1,
      "--region",
      "eu",
    ]);
    const { stdout } = await runCli(["auth", "list"]);
    expect(stdout).toContain("REGION");
    expect(stdout).toMatch(/dev\s+acme-test\s+us\s/);
    expect(stdout).toMatch(/eu-prof\s+globex-test\s+eu\s/);
  });
});

describe("configure key storage backend (CHARGEBEE_CONFIG_DIR forces the file store)", () => {
  it("configure reports the file backend and the CHARGEBEE_CONFIG_DIR note", async () => {
    const { stdout } = await configureProfile("dev", SITE_V2, KEY_V2);
    expect(stdout).toContain("Key     : stored in");
    expect(stdout).toContain(join(configDir, "profiles", "dev.json"));
    expect(stdout).toContain("Note    : CHARGEBEE_CONFIG_DIR is set");
  });

  it("auth status shows the profile-file backend", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    const { stdout } = await runCli(["auth", "status"]);
    expect(stdout).toContain("Key storage : profile file");
  });

  it("auth list shows the STORE column as file", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    const { stdout } = await runCli(["auth", "list"]);
    expect(stdout).toContain("STORE");
    expect(stdout).toMatch(/dev\s+acme-test\s+us\s+chargebee\.com\s+\S+\s+\S+\s+file/);
  });
});

describe("auth switch picker", () => {
  let restoreStdout: () => void;
  beforeEach(() => {
    setStdinIsTTY(true);
    restoreStdout = setStdoutIsTTY(true);
  });
  afterEach(() => {
    restoreStdout();
    setStdinIsTTY(false);
  });

  it("switches to the selected profile", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    await configureProfile("prod", SITE_V1, KEY_V1);
    __setPromptsForTest({
      select: async () => "dev",
    });
    const { stdout, exitCode } = await runCli(["auth", "switch"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Switched");
    expect(stdout).toContain("dev");
    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain(SITE_V2);
  });

  it("no-ops when the already-active profile is selected", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    __setPromptsForTest({
      select: async () => "dev",
    });
    const { stdout, exitCode } = await runCli(["auth", "switch"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Already active");
  });

  it("cancels without changing the active profile", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    await configureProfile("prod", SITE_V1, KEY_V1);
    __setPromptsForTest({
      select: async () => CANCEL,
    });
    const { stdout, exitCode } = await runCli(["auth", "switch"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Cancelled");
    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain(SITE_V1);
  });

  it("fails when there are no saved profiles", async () => {
    const { stderr, exitCode } = await runCli(["auth", "switch"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No saved profiles");
  });
});

describe("prompts refuse to open without a TTY", () => {
  let restoreStdout: () => void;
  beforeEach(() => {
    setStdinIsTTY(false);
    restoreStdout = setStdoutIsTTY(true);
  });
  afterEach(() => {
    restoreStdout();
  });

  it("auth add --site without a key exits 1 and never calls the password prompt", async () => {
    let prompted = false;
    __setPromptsForTest({
      password: async () => {
        prompted = true;
        return KEY_V2;
      },
    });
    const { stderr, exitCode } = await runCli(["auth", "add", "--site", SITE_V2]);
    expect(exitCode).toBe(1);
    expect(prompted).toBe(false);
    expect(stderr).toContain("--api-key");
    expect(constructions).toHaveLength(0);
  });

  it("auth switch with profiles exits 1 and never opens the picker", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    await configureProfile("prod", SITE_V1, KEY_V1);
    let prompted = false;
    __setPromptsForTest({
      select: async () => {
        prompted = true;
        return "dev";
      },
    });
    const { stderr, exitCode } = await runCli(["auth", "switch"]);
    expect(exitCode).toBe(1);
    expect(prompted).toBe(false);
    expect(stderr).toContain("chargebee auth switch <name>");
    expect(stderr).toContain("dev");
    expect(stderr).toContain("prod");
  });

  it("stdout must be a TTY too", async () => {
    setStdinIsTTY(true);
    restoreStdout();
    restoreStdout = setStdoutIsTTY(false);
    const { stderr, exitCode } = await runCli(["auth", "add", "--site", SITE_V2]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--api-key");
  });
});

describe("auth remove interactive", () => {
  beforeEach(() => {
    setStdinIsTTY(true);
  });

  afterEach(() => {
    setStdinIsTTY(false);
  });

  it("picks a profile and confirms deletion", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    await configureProfile("prod", SITE_V1, KEY_V1);
    __setPromptsForTest({
      select: async () => "dev",
      confirm: async () => true,
    });
    const { stdout, exitCode } = await runCli(["auth", "remove"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Removed");
    const list = await runCli(["auth", "list"]);
    expect(list.stdout).not.toContain("● dev");
    expect(list.stdout).toContain("prod");
  });

  it("leaves the profile when confirm is cancelled", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    __setPromptsForTest({
      confirm: async () => CANCEL,
    });
    const { exitCode } = await runCli(["auth", "remove", "dev"]);
    expect(exitCode).toBe(0);
    const list = await runCli(["auth", "list"]);
    expect(list.stdout).toContain("dev");
  });

  it("asks which profile to activate after removing the active one", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    await configureProfile("prod", SITE_V1, KEY_V1);
    __setPromptsForTest({
      confirm: async () => true,
      select: async (opts: { message: string }) => {
        if (String(opts.message).includes("active")) return "dev";
        return "prod";
      },
    });
    const { stdout, exitCode } = await runCli(["auth", "remove", "prod"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Active profile: "dev"');
    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain(SITE_V2);
  });

  it("disconnects when the next-active picker is cancelled", async () => {
    await configureProfile("dev", SITE_V2, KEY_V2);
    await configureProfile("prod", SITE_V1, KEY_V1);
    __setPromptsForTest({
      confirm: async () => true,
      select: async () => CANCEL,
    });
    const { stdout, exitCode } = await runCli(["auth", "remove", "prod"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No active profile");
    const status = await runCli(["auth", "status"]);
    expect(status.stdout).toContain("Not configured");
  });
});

describe("interactive auth add onboarding", () => {
  let home: string;
  let restoreStdout: () => void;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cb-onboard-home-"));
    env.set("HOME", home);
    env.set("SHELL", "/bin/zsh");
    env.set("CI", undefined);
    env.set("CHARGEBEE_CLI_NO_ONBOARDING", undefined);
    env.set("TERM", "xterm");
    setStdinIsTTY(true);
    restoreStdout = setStdoutIsTTY(true);
  });

  afterEach(() => {
    restoreStdout();
    setStdinIsTTY(false);
    rmSync(home, { recursive: true, force: true });
  });

  function onboardingConfirms(skill: boolean, alias: boolean) {
    const confirms: string[] = [];
    __setPromptsForTest({
      text: configureText(),
      password: async () => KEY_V2,
      confirm: async (opts: { message?: string }) => {
        const msg = String(opts.message ?? "");
        confirms.push(msg);
        if (/skill/i.test(msg)) return skill;
        if (/shortcut|cb /i.test(msg)) return alias;
        return false;
      },
      multiselect: async () => ["cursor"],
    });
    return confirms;
  }

  it("offers skill and alias, then writes the marker", async () => {
    const confirms = onboardingConfirms(true, true);
    const { stdout, exitCode } = await runCli(["auth", "add"]);
    expect(exitCode).toBe(0);
    expect(confirms).toHaveLength(2);
    expect(stdout).toContain("Installed Chargebee CLI skill");
    expect(stdout).toContain("Added alias 'cb'");
    expect(existsSync(join(home, ".cursor/skills/chargebee-cli/SKILL.md"))).toBe(true);
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).toContain("alias cb=");
    expect(JSON.parse(readFileSync(join(configDir, "onboarding.json"), "utf-8")).offered).toBe(
      true,
    );
  });

  it("does not nag on a second interactive auth add", async () => {
    onboardingConfirms(false, false);
    await runCli(["auth", "add"]);
    const confirms: string[] = [];
    __setPromptsForTest({
      text: configureText(SITE_V1, "two"),
      password: async () => KEY_V1,
      confirm: async (opts: { message?: string }) => {
        confirms.push(String(opts.message ?? ""));
        return false;
      },
    });
    const { stdout, exitCode } = await runCli(["auth", "add"]);
    expect(exitCode).toBe(0);
    expect(confirms).toHaveLength(0);
    expect(stdout).toContain("profile: two");
  });

  it("mentions declined commands in next steps", async () => {
    onboardingConfirms(false, false);
    const { stdout, exitCode } = await runCli(["auth", "add"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("chargebee skills add");
    expect(stdout).toContain("chargebee alias set");
    expect(stdout).toContain("Later: chargebee skills add");
    expect(stdout).toContain("Later: chargebee alias set");
  });

  it("skips onboarding on flagged configure", async () => {
    const confirms: string[] = [];
    __setPromptsForTest({
      confirm: async (opts: { message?: string }) => {
        confirms.push(String(opts.message ?? ""));
        return false;
      },
    });
    const { stdout, exitCode } = await runCli([
      "auth", "add",
      "--site",
      SITE_V2,
      "--api-key",
      KEY_V2,
    ]);
    expect(exitCode).toBe(0);
    expect(confirms).toHaveLength(0);
    expect(stdout).not.toContain("chargebee skills add");
    expect(existsSync(join(configDir, "onboarding.json"))).toBe(false);
  });

  it("still offers both confirms when the skill is already at HOME", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const { installSkill } = await import("../../lib/skills/index.js");
    await installSkill(home, "cursor", true);
    const confirms = onboardingConfirms(true, true);
    const { stdout } = await runCli(["auth", "add"]);
    expect(confirms).toHaveLength(2);
    expect(stdout).toContain("already installed");
  });

  it("still offers both confirms when cb already exists", async () => {
    writeFileSync(join(home, ".zshrc"), "alias cb='chargebee'\n");
    const confirms = onboardingConfirms(false, true);
    await runCli(["auth", "add"]);
    expect(confirms).toHaveLength(2);
    expect(confirms[0]).toMatch(/skill/i);
    expect(confirms[1]).toMatch(/cb shortcut/i);
  });

  it("re-asks after onboarding.json is removed", async () => {
    onboardingConfirms(true, true);
    await runCli(["auth", "add"]);
    expect(existsSync(join(configDir, "onboarding.json"))).toBe(true);
    rmSync(join(configDir, "onboarding.json"));
    const confirms = onboardingConfirms(false, false);
    const { stdout, exitCode } = await runCli(["auth", "add"]);
    expect(exitCode).toBe(0);
    expect(confirms).toHaveLength(2);
    expect(stdout).toContain("Later: chargebee skills add");
  });
});

