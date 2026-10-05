import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../../lib/test-support/_helpers.js";

describe("chargebee alias (sandboxed HOME)", () => {
  const prevHome = process.env.HOME;
  const prevShell = process.env.SHELL;
  const prevConfig = process.env.CHARGEBEE_CONFIG_DIR;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cb-alias-home-"));
    process.env.HOME = home;
    process.env.SHELL = "/bin/zsh";
    process.env.CHARGEBEE_CONFIG_DIR = join(home, ".chargebee", "cli");
    mkdirSync(process.env.CHARGEBEE_CONFIG_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = prevShell;
    if (prevConfig === undefined) delete process.env.CHARGEBEE_CONFIG_DIR;
    else process.env.CHARGEBEE_CONFIG_DIR = prevConfig;
  });

  it("set writes an alias into ~/.zshrc", async () => {
    const { stdout, exitCode } = await runCli(["alias", "set", "cbx"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Added alias 'cbx'");
    const rc = readFileSync(join(home, ".zshrc"), "utf-8");
    expect(rc).toContain("alias cbx=");
    expect(rc).toContain("# chargebee-cli alias");
  });

  it("set is a no-op when the alias already exists", async () => {
    await runCli(["alias", "set", "cbx"]);
    const { stdout, exitCode } = await runCli(["alias", "set", "cbx"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("already exists");
  });

  it("remove deletes the alias and its comment", async () => {
    await runCli(["alias", "set", "cbx"]);
    const { stdout, exitCode } = await runCli(["alias", "remove", "cbx"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Removed alias 'cbx'");
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).not.toContain(
      "alias cbx=",
    );
  });

  it("remove reports missing profile and missing alias", async () => {
    const missingFile = await runCli(["alias", "remove", "cbx"]);
    expect(missingFile.stdout).toContain("does not exist");
    writeFileSync(join(home, ".zshrc"), "# empty\n");
    const missingAlias = await runCli(["alias", "remove", "cbx"]);
    expect(missingAlias.stdout).toContain("No alias 'cbx' found");
  });

  it("show lists matching aliases or a hint", async () => {
    const empty = await runCli(["alias", "show"]);
    expect(empty.stdout).toContain("No shell profile found");
    await runCli(["alias", "set"]);
    const listed = await runCli(["alias", "show"]);
    expect(listed.stdout).toMatch(/alias cb=/);
    writeFileSync(join(home, ".zshrc"), "alias other=foo\n");
    const none = await runCli(["alias", "show"]);
    expect(none.stdout).toContain("No chargebee aliases found");
  });

  it("rejects an invalid alias name and unknown action", async () => {
    const bad = await runCli(["alias", "set", "bad name"]);
    expect(bad.exitCode).not.toBe(0);
    const unknown = await runCli(["alias", "explode"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Unknown action");
  });

  it("set refuses a foreign alias unless --force, and remove preserves it", async () => {
    const rcPath = join(home, ".zshrc");
    writeFileSync(rcPath, "alias cbx='couchbase-cli'\n");

    const refused = await runCli(["alias", "set", "cbx"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("already defined");
    expect(readFileSync(rcPath, "utf-8")).toBe("alias cbx='couchbase-cli'\n");

    const removed = await runCli(["alias", "remove", "cbx"]);
    expect(removed.stdout).toContain("No alias 'cbx' found");
    expect(readFileSync(rcPath, "utf-8")).toBe("alias cbx='couchbase-cli'\n");

    const forced = await runCli(["alias", "set", "cbx", "--force"]);
    expect(forced.exitCode).toBe(0);
    const afterForce = readFileSync(rcPath, "utf-8");
    expect(afterForce).toContain("alias cbx='couchbase-cli'");
    expect(afterForce).toContain("# chargebee-cli alias");

    await runCli(["alias", "remove", "cbx"]);
    const afterRemove = readFileSync(rcPath, "utf-8");
    expect(afterRemove).toContain("alias cbx='couchbase-cli'");
    expect(afterRemove).not.toContain("chargebee-cli alias");
  });

  it("writes a single backup before the first modification and preserves CRLF", async () => {
    const rcPath = join(home, ".zshrc");
    writeFileSync(rcPath, "export PATH=$PATH\r\nalias ll='ls -la'\r\n");

    await runCli(["alias", "set", "cbx"]);
    const backupPath = `${rcPath}.chargebee-cli.bak`;
    const backup = readFileSync(backupPath, "utf-8");
    expect(backup).toBe("export PATH=$PATH\r\nalias ll='ls -la'\r\n");

    const afterSet = readFileSync(rcPath, "utf-8");
    expect(afterSet).toContain("\r\n");
    expect(afterSet).toContain("alias ll='ls -la'");

    await runCli(["alias", "remove", "cbx"]);
    // The backup is written once and untouched by later edits.
    expect(readFileSync(backupPath, "utf-8")).toBe(backup);
    const afterRemove = readFileSync(rcPath, "utf-8");
    expect(afterRemove).toContain("alias ll='ls -la'");
    expect(afterRemove).not.toContain("alias cbx=");
  });
});
