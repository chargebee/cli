import { describe, expect, it } from "bun:test";

import { colorEnabled, paint } from "../../../../lib/ui/color.js";
import { blockedWriteMessage } from "../../../../lib/api/write-gate.js";

const tty: Parameters<typeof colorEnabled>[0] = {
  stdoutIsTTY: true,
  env: { TERM: "xterm-256color" },
};

describe("colorEnabled", () => {
  it("is true on an interactive TTY with no overrides", () => {
    expect(colorEnabled(tty)).toBe(true);
  });

  it("is false when stdout is not a TTY (piped)", () => {
    expect(colorEnabled({ ...tty, stdoutIsTTY: false })).toBe(false);
  });

  it("is false when TERM is dumb", () => {
    expect(colorEnabled({ ...tty, env: { TERM: "dumb" } })).toBe(false);
  });

  it("is false when NO_COLOR is set, to any value", () => {
    expect(colorEnabled({ ...tty, env: { ...tty.env, NO_COLOR: "1" } })).toBe(false);
    expect(colorEnabled({ ...tty, env: { ...tty.env, NO_COLOR: "0" } })).toBe(false);
    expect(colorEnabled({ ...tty, env: { ...tty.env, NO_COLOR: "" } })).toBe(false);
  });

  it("is false when FORCE_COLOR=0", () => {
    expect(colorEnabled({ ...tty, env: { ...tty.env, FORCE_COLOR: "0" } })).toBe(false);
  });

  it("FORCE_COLOR (non-'0') enables color even without a TTY", () => {
    expect(colorEnabled({ ...tty, stdoutIsTTY: false, env: { ...tty.env, FORCE_COLOR: "1" } })).toBe(true);
  });

  it("NO_COLOR wins over FORCE_COLOR", () => {
    expect(
      colorEnabled({ ...tty, env: { ...tty.env, NO_COLOR: "1", FORCE_COLOR: "1" } }),
    ).toBe(false);
  });

  it("gate messages carry no escape codes when NO_COLOR is set", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      expect(blockedWriteMessage("acme")).not.toContain("\x1b");
      expect(paint("31", "x")).toBe("x");
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });

  it("defaults to the real process.env / process.stdout.isTTY when no opts are given", () => {
    expect(typeof colorEnabled()).toBe("boolean");
  });
});

describe("paint", () => {
  it("wraps text in the given SGR code and a reset when color is enabled", () => {
    expect(paint("32", "✔", tty)).toBe("\x1b[32m✔\x1b[0m");
  });

  it("returns the text unchanged when color is disabled", () => {
    expect(paint("32", "✔", { ...tty, env: { ...tty.env, NO_COLOR: "1" } })).toBe("✔");
  });
});
