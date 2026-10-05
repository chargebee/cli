/**
 * Named profiles live tests — real Chargebee API calls.
 *
 * These tests spawn the CLI against a Chargebee `-test` site (`bun src/index.ts`,
 * or `CHARGEBEE_CLI_BINARY` when set — trusted live CI compiles a native
 * binary on Ubuntu, macOS, and Windows and points this env at it). They run only when:
 *
 *   CB_TEST_SITE_1   e.g. acme-test
 *   CB_TEST_KEY_1    e.g. test_xxx
 *   CB_TEST_SITE_2   e.g. acme-test2
 *   CB_TEST_KEY_2    e.g. test_yyy
 *
 * Run with:
 *   CB_TEST_SITE_1=xxx CB_TEST_KEY_1=yyy ... bun run test:live
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  spawnCli,
  writeDisabledTelemetry,
} from "../../lib/test-support/_spawn.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SITE_1 = process.env.CB_TEST_SITE_1;
const KEY_1 = process.env.CB_TEST_KEY_1;
const SITE_2 = process.env.CB_TEST_SITE_2;
const KEY_2 = process.env.CB_TEST_KEY_2;

const hasCredentials = Boolean(SITE_1 && KEY_1 && SITE_2 && KEY_2);

/**
 * Trusted CI (and anyone who opts in locally) sets CB_REQUIRE_LIVE=1 to demand
 * the live suite actually runs. When it's set but credentials are missing we
 * fail loudly instead of silently skipping — so a misconfigured trusted job can
 * never go green without exercising these paths. Fork PRs / normal local runs
 * leave it unset and keep the suite as an opt-in skip.
 */
const requireLive = ["1", "true", "yes"].includes(
  (process.env.CB_REQUIRE_LIVE ?? "").trim().toLowerCase(),
);

/**
 * Register the live suite ONLY when it will actually run (credentials present).
 * Unlike `describe.skipIf`, a no-op registrar adds nothing to the run, so public
 * CI (no creds) reports zero skips instead of a wall of skipped tests. A
 * misconfigured trusted run is still caught by the fail-loud precondition above.
 */
const describeLive: typeof describe = hasCredentials
  ? describe
  : ((() => {}) as unknown as typeof describe);

describe("live integration preconditions", () => {
  it("credentials are present when CB_REQUIRE_LIVE is set", () => {
    if (requireLive && !hasCredentials) {
      throw new Error(
        "CB_REQUIRE_LIVE is set but live test credentials are missing.\n" +
          "Set CB_TEST_SITE_1, CB_TEST_KEY_1, CB_TEST_SITE_2 and CB_TEST_KEY_2 " +
          "(test-mode keys on -test sites) before running the live suite.",
      );
    }
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spawn the CLI in an isolated config dir and return stdout/stderr/exit code. */
async function cli(
  args: string[],
  extraEnv: Record<string, string> = {},
  configDir?: string,
) {
  return spawnCli(args, { extraEnv, configDir });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeLive("named profiles — live", () => {
  let configDir: string;

  beforeAll(() => {
    configDir = mkdtempSync(join(tmpdir(), "cb-live-"));
    writeDisabledTelemetry(configDir);
  });

  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  // ── Scenario 1: Env var auth (CI/scripting use case) ────────────────────

  describe("env var auth — no login needed", () => {
    it("site 1 returns a customer list via env vars", async () => {
      const { stdout, exitCode } = await cli(["customer", "list"], {
        CHARGEBEE_SITE: SITE_1!,
        CHARGEBEE_API_KEY: KEY_1!,
      });
      expect(exitCode).toBe(0);
      const data = JSON.parse(stdout);
      expect(data.list).toBeDefined();
      expect(Array.isArray(data.list)).toBe(true);
    });

    it("site 2 returns a customer list via env vars", async () => {
      const { stdout, exitCode } = await cli(["customer", "list"], {
        CHARGEBEE_SITE: SITE_2!,
        CHARGEBEE_API_KEY: KEY_2!,
      });
      expect(exitCode).toBe(0);
      const data = JSON.parse(stdout);
      expect(data.list).toBeDefined();
    });

    it("env vars select two distinct sites", async () => {
      expect(SITE_1).not.toBe(SITE_2);
      expect(KEY_1).not.toBe(KEY_2);
      const [s1, s2] = await Promise.all([
        cli(["auth", "status"], {
          CHARGEBEE_SITE: SITE_1!,
          CHARGEBEE_API_KEY: KEY_1!,
        }),
        cli(["auth", "status"], {
          CHARGEBEE_SITE: SITE_2!,
          CHARGEBEE_API_KEY: KEY_2!,
        }),
      ]);
      expect(s1.exitCode).toBe(0);
      expect(s2.exitCode).toBe(0);
      expect(s1.stdout).toContain(`Site        : ${SITE_1}`);
      expect(s2.stdout).toContain(`Site        : ${SITE_2}`);
    });

    it("fails clearly when only CHARGEBEE_SITE is set (missing API key)", async () => {
      const { stderr, exitCode } = await cli(["customer", "list"], {
        CHARGEBEE_SITE: SITE_1!,
        // CHARGEBEE_API_KEY deliberately omitted
      });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("CHARGEBEE_API_KEY");
    });

    it("fails clearly when only CHARGEBEE_API_KEY is set (missing site)", async () => {
      const { stderr, exitCode } = await cli(["customer", "list"], {
        CHARGEBEE_API_KEY: KEY_1!,
        // CHARGEBEE_SITE deliberately omitted
      });
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("CHARGEBEE_SITE");
    });
  });

  // ── Scenario 2: Named profile creation ──────────────────────────────────

  describe("named profile creation", () => {
    it("creates profile 'dev' for site 1", async () => {
      const { exitCode, stdout } = await cli(
        [
          "auth", "add",
          "--profile",
          "dev",
          "--site",
          SITE_1!,
        ],
        { CHARGEBEE_API_KEY: KEY_1! },
        configDir,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("dev");
      expect(stdout).toContain(SITE_1!);
    });

    it("creates profile 'prod' for site 2", async () => {
      const { exitCode, stdout } = await cli(
        [
          "auth", "add",
          "--profile",
          "prod",
          "--site",
          SITE_2!,
        ],
        { CHARGEBEE_API_KEY: KEY_2! },
        configDir,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("prod");
      expect(stdout).toContain(SITE_2!);
    });

    it("auth list shows both profiles", async () => {
      const { exitCode, stdout } = await cli(
        ["auth", "list"],
        {},
        configDir,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("dev");
      expect(stdout).toContain("prod");
      expect(stdout).toContain(SITE_1!);
      expect(stdout).toContain(SITE_2!);
    });

    it("most recently configured profile is active", async () => {
      // 'prod' was configured last — `auth add` makes it the active profile
      const { stdout } = await cli(["auth", "list"], {}, configDir);
      const lines = stdout.split("\n");
      const prodLine = lines.find((l) => l.includes("prod"));
      expect(prodLine).toContain("active");
    });
  });

  // ── Scenario 3: Profile switching ───────────────────────────────────────

  describe("profile switching", () => {
    it("switching to 'dev' makes API calls against site 1", async () => {
      await cli(["auth", "switch", "dev"], {}, configDir);
      const { stdout } = await cli(["auth", "status"], {}, configDir);
      expect(stdout).toContain("Connected");
      expect(stdout).toContain(SITE_1!);
    });

    it("chargebee auth switch prod switches to site 2", async () => {
      const { exitCode, stdout } = await cli(
        ["auth", "switch", "prod"],
        {},
        configDir,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain("prod");
    });

    it("after switching, auth status shows site 2", async () => {
      const { stdout } = await cli(["auth", "status"], {}, configDir);
      expect(stdout).toContain(SITE_2!);
      expect(stdout).toContain("prod");
    });

    it("customer list after switch uses site 2's data", async () => {
      const { stdout, exitCode } = await cli(
        ["customer", "list"],
        {},
        configDir,
      );
      expect(exitCode).toBe(0);
      const data = JSON.parse(stdout);
      expect(data.list).toBeDefined();
    });

    it("switching back to dev works", async () => {
      await cli(["auth", "switch", "dev"], {}, configDir);
      const { stdout } = await cli(["auth", "status"], {}, configDir);
      expect(stdout).toContain(SITE_1!);
    });
  });

  // ── Scenario 4: Per-command --use-profile override ─────────────────────

  describe("--use-profile per-command override", () => {
    it("--use-profile prod uses site 2 without switching active profile", async () => {
      // Active is 'dev' (site 1). Override to 'prod' for one command.
      const { stdout, exitCode } = await cli(
        ["--use-profile", "prod", "customer", "list"],
        {},
        configDir,
      );
      expect(exitCode).toBe(0);
      const data = JSON.parse(stdout);
      expect(data.list).toBeDefined();
    });

    it("active profile is still 'dev' after the per-command override", async () => {
      const { stdout } = await cli(["auth", "status"], {}, configDir);
      expect(stdout).toContain(SITE_1!); // active didn't change
    });
  });

  // ── Scenario 5: Error handling ──────────────────────────────────────────

  describe("error handling", () => {
    it("clear error when no config and no env vars", async () => {
      const emptyDir = mkdtempSync(join(tmpdir(), "cb-empty-"));
      try {
        const { stderr, exitCode } = await cli(
          ["customer", "list"],
          {},
          emptyDir,
        );
        expect(exitCode).not.toBe(0);
        expect(stderr.toLowerCase()).toMatch(
          /not configured|chargebee auth add/,
        );
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it("clear error for unknown profile in --use-profile", async () => {
      const { stderr, exitCode } = await cli(
        ["--use-profile", "ghost", "customer", "list"],
        {},
        configDir,
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("ghost");
    });

    it("use command fails clearly for unknown profile", async () => {
      const { stderr, exitCode } = await cli(
        ["auth", "switch", "doesnotexist"],
        {},
        configDir,
      );
      expect(exitCode).toBe(1);
      expect(stderr).toContain("doesnotexist");
    });

    it("env vars take precedence over stored profiles", async () => {
      // configDir has 'dev' (site 1) as active, but env vars point to site 2
      const { stdout, exitCode } = await cli(
        ["auth", "status"],
        { CHARGEBEE_SITE: SITE_2!, CHARGEBEE_API_KEY: KEY_2! },
        configDir,
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain(SITE_2!);
      expect(stdout).toContain("environment variables");
    });
  });
});
