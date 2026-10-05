import { describe, expect, it } from "bun:test";

import { buildProgram } from "../../../../program.js";
import { knownCommandPath } from "../../../../lib/telemetry/command-path.js";

describe("knownCommandPath", () => {
  const program = buildProgram("0.0.0-test");

  it("walks registered resource + operation names", () => {
    expect(knownCommandPath(program, ["customer", "list"])).toBe("customer list");
  });

  it("stops before positional ids", () => {
    expect(knownCommandPath(program, ["customer", "retrieve", "cust_abc"])).toBe(
      "customer retrieve",
    );
  });

  it("ignores flags and their values", () => {
    expect(knownCommandPath(program, ["--help", "customer", "list", "--limit", "2"])).toBe(
      "customer list",
    );
  });

  it("returns empty for a token that is not a command", () => {
    expect(knownCommandPath(program, ["not-a-command"])).toBe("");
  });
});
