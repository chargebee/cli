import { describe, expect, it } from "bun:test";

import { renderBox } from "../../../../lib/ui/box.js";

describe("renderBox", () => {
  it("pads body rows so corners line up", () => {
    const box = renderBox("Quick Start", [
      " 1. chargebee auth add           Connect your site",
      " 2. chargebee customer list       Try an API command",
    ]);
    const lines = box.split("\n");
    const widths = lines.map((l) => [...l].length);
    expect(new Set(widths).size).toBe(1);
    expect(lines[0]).toMatch(/^┌ Quick Start ─+┐$/);
    expect(lines[lines.length - 1]).toMatch(/^└─+┘$/);
  });
});
