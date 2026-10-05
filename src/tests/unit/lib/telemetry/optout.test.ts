import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ENV_FLUSH_CHILD } from "../../../../lib/telemetry/constants.js";
import { markInteractive, wasInteractive, __resetInteractiveForTest } from "../../../../lib/telemetry/interactive.js";
import {
  disabledSource,
  isTelemetryDisabled,
  maybeShowFirstRunNotice,
  setTelemetryEnabled,
} from "../../../../lib/telemetry/optout.js";
import { readState, writeState } from "../../../../lib/telemetry/state.js";

import { clearCiEnv } from "../../../../lib/test-support/_helpers.js";

// Telemetry is disabled on a CI runner; these tests exercise it, so clear CI detection.
let restoreCiEnv: () => void = () => undefined;
beforeEach(() => {
  restoreCiEnv = clearCiEnv();
});
afterEach(() => restoreCiEnv());

describe("telemetry opt-out + first-run notice", () => {
  const prevDir = process.env.CHARGEBEE_CONFIG_DIR;
  const prevFlush = process.env[ENV_FLUSH_CHILD];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-optout-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    delete process.env[ENV_FLUSH_CHILD];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prevDir;
    if (prevFlush === undefined) delete process.env[ENV_FLUSH_CHILD];
    else process.env[ENV_FLUSH_CHILD] = prevFlush;
  });

  it("is disabled in the flush child even when opted in", () => {
    expect(isTelemetryDisabled()).toBe(false);
    process.env[ENV_FLUSH_CHILD] = "1";
    expect(isTelemetryDisabled()).toBe(true);
  });

  it("is disabled after telemetry disable persists", () => {
    expect(setTelemetryEnabled(false)).toBe(true);
    expect(isTelemetryDisabled()).toBe(true);
    expect(readState().enabled).toBe(false);
  });

  it("prints the first-run notice once to stderr", () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
      writes.push(c);
      return true;
    };
    let first: boolean;
    let second: boolean;
    try {
      first = maybeShowFirstRunNotice();
      second = maybeShowFirstRunNotice();
    } finally {
      process.stderr.write = orig;
    }
    // Only the call that actually printed reports true; that run must not record.
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(writes.join("")).toContain("chargebee telemetry disable");
    expect(readState().notice_shown).toBe(true);
    const firstCount = writes.length;
    expect(maybeShowFirstRunNotice()).toBe(false);
    expect(writes.length).toBe(firstCount);
  });

  it("notice states exactly what is sent and does not claim anonymity (#114)", () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
      writes.push(c);
      return true;
    };
    try {
      maybeShowFirstRunNotice();
    } finally {
      process.stderr.write = orig;
    }
    const text = writes.join("");
    // What is sent: site name and a stable install id are the parts users must know about.
    expect(text).toMatch(/site name/i);
    expect(text).toMatch(/install id/i);
    expect(text).toMatch(/command name/i);
    // What is not sent.
    expect(text).toMatch(/API keys/);
    expect(text).toMatch(/argument values/i);
    // This run is not recorded, so opting out first is possible.
    expect(text).toMatch(/not recorded|nothing (is|was) recorded/i);
    expect(text).toContain("chargebee telemetry disable");
    expect(text).toContain("TELEMETRY.md");
    // No more "anonymous" / "no personal data" framing.
    expect(text).not.toMatch(/anonymous/i);
    expect(text).not.toMatch(/no personal data/i);
    // Keep it short on the terminal.
    expect(text.split("\n").filter((l) => l.trim()).length).toBeLessThanOrEqual(4);
  });

  it("skips the notice when telemetry is disabled", () => {
    setTelemetryEnabled(false);
    const orig = process.stderr.write.bind(process.stderr);
    let wrote = false;
    (process.stderr as unknown as { write: (c: string) => boolean }).write = () => {
      wrote = true;
      return true;
    };
    try {
      maybeShowFirstRunNotice();
    } finally {
      process.stderr.write = orig;
    }
    expect(wrote).toBe(false);
  });
});

describe("telemetry env-var opt-out and CI/read-only handling (#124)", () => {
  const prevDir = process.env.CHARGEBEE_CONFIG_DIR;
  const prevDoNotTrack = process.env.DO_NOT_TRACK;
  const prevCliTelemetry = process.env.CHARGEBEE_CLI_TELEMETRY;
  const prevCi = process.env.CI;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-optout-env-"));
    process.env.CHARGEBEE_CONFIG_DIR = dir;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CHARGEBEE_CLI_TELEMETRY;
    delete process.env.CI;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prevDir;
    if (prevDoNotTrack === undefined) delete process.env.DO_NOT_TRACK;
    else process.env.DO_NOT_TRACK = prevDoNotTrack;
    if (prevCliTelemetry === undefined) delete process.env.CHARGEBEE_CLI_TELEMETRY;
    else process.env.CHARGEBEE_CLI_TELEMETRY = prevCliTelemetry;
    if (prevCi === undefined) delete process.env.CI;
    else process.env.CI = prevCi;
  });

  for (const value of ["1", "true", "yes"]) {
    it(`DO_NOT_TRACK=${value} disables telemetry`, () => {
      process.env.DO_NOT_TRACK = value;
      expect(isTelemetryDisabled()).toBe(true);
      expect(disabledSource()).toBe("DO_NOT_TRACK");
    });
  }

  for (const value of ["0", "false", "off"]) {
    it(`CHARGEBEE_CLI_TELEMETRY=${value} disables telemetry`, () => {
      process.env.CHARGEBEE_CLI_TELEMETRY = value;
      expect(isTelemetryDisabled()).toBe(true);
      expect(disabledSource()).toBe("CHARGEBEE_CLI_TELEMETRY");
    });
  }

  it("does not disable on an unset or falsy DO_NOT_TRACK", () => {
    process.env.DO_NOT_TRACK = "0";
    expect(isTelemetryDisabled()).toBe(false);
    delete process.env.DO_NOT_TRACK;
    expect(isTelemetryDisabled()).toBe(false);
  });

  it("disables telemetry entirely when CI is truthy", () => {
    process.env.CI = "true";
    expect(isTelemetryDisabled()).toBe(true);
    expect(disabledSource()).toBe("CI");
  });

  it("env opt-out wins over a persisted enabled:true state file", () => {
    writeState({ enabled: true });
    process.env.DO_NOT_TRACK = "1";
    expect(isTelemetryDisabled()).toBe(true);
    expect(disabledSource()).toBe("DO_NOT_TRACK");
    expect(readState().enabled).toBe(true); // the state file itself is untouched
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "treats an unwritable config dir as disabled: no banner, no visitor-id churn",
    () => {
      chmodSync(dir, 0o500);
      try {
        expect(isTelemetryDisabled()).toBe(true);
        expect(disabledSource()).toBe("state_dir_unwritable");

        const writes: string[] = [];
        const orig = process.stderr.write.bind(process.stderr);
        (process.stderr as unknown as { write: (c: string) => boolean }).write = (c: string) => {
          writes.push(c);
          return true;
        };
        try {
          expect(maybeShowFirstRunNotice()).toBe(false);
        } finally {
          process.stderr.write = orig;
        }
        expect(writes).toHaveLength(0);
      } finally {
        chmodSync(dir, 0o700); // afterEach's rmSync needs write access back
      }
    },
  );
});

describe("interactive flag", () => {
  beforeEach(() => {
    __resetInteractiveForTest();
  });

  afterEach(() => {
    __resetInteractiveForTest();
  });

  it("defaults false and latches true", () => {
    expect(wasInteractive()).toBe(false);
    markInteractive();
    expect(wasInteractive()).toBe(true);
  });
});
