/**
 * `auth add` must not persist a profile — or mark it active — unless
 * verification against the Configuration API actually succeeded. This
 * isolated CLI test drives a fake SDK client that throws a transport-level
 * failure (no HTTP response at all), the same shape Node's global `fetch`
 * produces on a DNS/connection failure.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __setClientFactory, __resetRuntimeState } from "../../lib/api/sdk.js";
import { createEnvPatcher, runCli } from "../../lib/test-support/_helpers.js";

let configDir: string;
const env = createEnvPatcher();

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "cb-configure-network-"));
  env.set("CHARGEBEE_CONFIG_DIR", configDir);
  env.set("CHARGEBEE_SITE", undefined);
  env.set("CHARGEBEE_API_KEY", undefined);
  env.set("CHARGEBEE_ENV", undefined);
  env.set("CHARGEBEE_HOST", undefined);
});

afterEach(() => {
  __setClientFactory(null);
  __resetRuntimeState();
  env.restore();
  rmSync(configDir, { recursive: true, force: true });
});

describe("configure on a transport failure", () => {
  it("exits 1 and writes no profile when the Configuration API call cannot reach the host", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND acme-test.chargebee.com"), { code: "ENOTFOUND" });
    __setClientFactory(() => ({
      configuration: {
        list: async () => {
          throw new TypeError("fetch failed", { cause });
        },
      },
    }) as never);

    const { stderr, exitCode } = await runCli([
      "auth", "add",
      "--profile",
      "dev",
      "--site",
      "acme-test",
      "--api-key",
      "test_key",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Could not reach "acme-test": ENOTFOUND');
    expect(stderr).not.toContain("Credentials verified");

    const profilesDir = join(configDir, "profiles");
    expect(existsSync(join(profilesDir, "dev.json"))).toBe(false);
    if (existsSync(profilesDir)) {
      expect(readdirSync(profilesDir)).toHaveLength(0);
    }
    expect(existsSync(join(configDir, "config"))).toBe(false);
  });
});
