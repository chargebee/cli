/**
 * Isolated CLI tests for root help IA, `chargebee resources`, and `[id]` docs (#63).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEnvPatcher,
  installFakeClient,
  runCli,
  uninstallFakeClient,
  type ClientConstruction,
} from "../../lib/test-support/_helpers.js";
import { __setClientFactory } from "../../lib/api/sdk.js";
import { formatColumns } from "../../commands/help.js";

const repoRoot = join(import.meta.dir, "../../..");

const env = createEnvPatcher();

function parseHelpExample(help: string): string[] | undefined {
  const section = help.split("\nEXAMPLE\n")[1]?.split("\n\n")[0];
  if (!section) return undefined;
  const input = section.trim().replace(/\\\n\s*/g, " ");
  const tokens: string[] = [];
  let current = "";
  let quote = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote && ch === "'") { quote = false; continue; }
    if (!quote && ch === "'") { quote = true; continue; }
    if (!quote && ch === "\\" && i + 1 < input.length) { current += input[++i]; continue; }
    if (!quote && /\s/.test(ch)) {
      if (current) { tokens.push(current); current = ""; }
    } else current += ch;
  }
  if (current) tokens.push(current);
  return tokens[0] === "chargebee" ? tokens.slice(1) : undefined;
}

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "cb-help-ia-"));
  env.set("CHARGEBEE_CONFIG_DIR", configDir);
  env.set("CHARGEBEE_SITE", undefined);
  env.set("CHARGEBEE_API_KEY", undefined);
});

afterEach(() => {
  uninstallFakeClient();
  env.restore();
  rmSync(configDir, { recursive: true, force: true });
});

describe("root help IA", () => {
  it("uses job sections, featured resources, and unique flags — not a 100-name dump", async () => {
    const { stdout, exitCode } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("USAGE");
    expect(stdout).toContain("CORE");
    expect(stdout).not.toContain("GET STARTED");
    expect(stdout).toMatch(/MORE[\s\S]*update\s+Update the Chargebee CLI/);
    expect(stdout).toMatch(
      /listen\s+Forward webhook events on your local machine/,
    );
    expect(stdout).toContain("API");
    expect(stdout).toContain("MORE");
    expect(stdout).toContain("GLOBAL FLAGS");
    expect(stdout).toContain("OPERATION FLAGS");
    expect(stdout).toContain("SITE FLAGS");
    expect(stdout).toContain("use");
    expect(stdout).toMatch(/auth\s+Manage API-key authentication and saved profiles/);
    expect(stdout).not.toContain("list, status, remove, rename, use");
    expect(stdout).toContain("Languages: curl, python");
    expect(stdout).toMatch(/skills\s+Manage Chargebee Agent Skills\n\n/);
    expect(stdout).toContain("chargebee skills add");
    expect(stdout).toContain("--use-profile");
    expect(stdout).toContain("--code-sample");
    expect(stdout).toContain("-v, --version");
    expect(stdout).toMatch(/item-price.*\n\n  These are the most used\. Run "chargebee resources" for the full list\.\n/);
    expect(stdout).not.toMatch(/^  resources\s/m);
    expect(stdout).toContain("chargebee auth add");
    expect(stdout).not.toContain("--host");
  });

  it("prints root help to stdout and exits 0 when run with no arguments", async () => {
    const bare = await runCli([]);
    const help = await runCli(["--help"]);
    expect(bare.exitCode).toBe(0);
    expect(bare.stderr).toBe("");
    expect(bare.stdout).toBe(help.stdout);
  });

  it("keeps an unknown help topic an error", async () => {
    const { exitCode } = await runCli(["help", "no-such-command"]);
    expect(exitCode).toBe(1);
  });

  it("shows flag syntax that matches the real options, in one aligned column", async () => {
    const { stdout } = await runCli(["--help"]);
    expect(stdout).toContain("-d, --data <key=value>");
    expect(stdout).toContain("-s, --code-sample <lang>");
    expect(stdout).toContain("--use-profile <profile>");
    const flagRows = stdout
      .split("\n")
      .filter((l) => /^  (-\w, )?--[a-z-]+/.test(l));
    expect(flagRows.length).toBeGreaterThanOrEqual(6);
    const descriptionColumns = flagRows.map((l) => l.match(/^ +\S.*? {2,}(?=\S)/)?.[0].length);
    expect(new Set(descriptionColumns).size).toBe(1);
  });

  it("links to the API reference and CLI source", async () => {
    const { stdout } = await runCli(["--help"]);
    expect(stdout).toContain("https://apidocs.chargebee.com/");
    expect(stdout).toContain("https://github.com/chargebee/cli");
  });

  it("bolds section titles only when color is enabled", async () => {
    env.set("NO_COLOR", undefined);
    env.set("FORCE_COLOR", "1");
    const colored = await runCli(["--help"]);
    expect(colored.stdout).toContain("\x1b[1mUSAGE\x1b[0m");
    env.set("NO_COLOR", "1");
    const plain = await runCli(["--help"]);
    expect(plain.stdout).not.toContain("\x1b[");
  });

  it("shows runnable examples and the live-site write gate", async () => {
    const { stdout } = await runCli(["--help"]);
    expect(stdout).toContain("Write operations are blocked on live sites");
    expect(stdout).toContain('Run "chargebee <command> --help" for details.');
    const examples = stdout.split("\nEXAMPLES\n")[1]?.split("\n\n")[0]?.split("\n") ?? [];
    expect(examples.length).toBeGreaterThanOrEqual(3);
    for (const line of examples) {
      const args = line.trim().split(/\s+/).slice(1);
      const withSample = args.includes("-s") ? args : [...args, "-s", "curl"];
      const result = await runCli(withSample);
      expect(result.exitCode).toBe(0);
    }
  });

  it("aligns every Quick Start box line to the same length", async () => {
    const { stdout, exitCode } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    const boxLines = stdout
      .split("\n")
      .filter(
        (l) => l.startsWith("┌") || l.startsWith("│") || l.startsWith("└"),
      );
    expect(boxLines.length).toBeGreaterThanOrEqual(4);
    const widths = boxLines.map((l) => [...l].length);
    expect(new Set(widths).size).toBe(1);
  });

  it("shows Connected in Quick Start when a site is configured", async () => {
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    const { stdout, exitCode } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Connected to acme-test");
  });

  it("truncates a long connected site name in Quick Start", async () => {
    env.set("CHARGEBEE_SITE", "verylongmerchantname-that-exceeds-thirty-six-test");
    env.set("CHARGEBEE_API_KEY", "test_xxx");
    const { stdout, exitCode } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Connected to");
    expect(stdout).toContain("...");
    expect(stdout).not.toContain("verylongmerchantname-that-exceeds-thirty-six-test");
  });
});

describe("subcommand help", () => {
  it("uses the root help's section style and wording", async () => {
    const { stdout, exitCode } = await runCli(["customer", "create", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^Usage: chargebee customer create /);
    expect(stdout).toContain("\nOPTIONS\n");
    expect(stdout).toContain("\nDOCUMENTATION\n  chargebee docs customer create");
    expect(stdout).toMatch(/-h, --help\s+Show help/);
    expect(stdout).not.toContain("display help for command");
    expect(stdout).not.toMatch(/^[A-Za-z ]+:$/m);
  });

  it("describes the help subcommand in the same wording", async () => {
    const { stdout } = await runCli(["customer", "--help"]);
    expect(stdout).toMatch(/help \[command\]\s+Show help for a command/);
  });

  it("bolds subcommand section titles when color is enabled", async () => {
    env.set("NO_COLOR", undefined);
    env.set("FORCE_COLOR", "1");
    const { stdout } = await runCli(["auth", "add", "--help"]);
    expect(stdout).toContain("\x1b[1mOPTIONS\x1b[0m");
    expect(stdout).toContain("\x1b[1mEXAMPLES\x1b[0m");
  });

  it("prints help to stdout and exits 0 for a bare command group", async () => {
    const bare = await runCli(["customer"]);
    expect(bare.exitCode).toBe(0);
    expect(bare.stderr).toBe("");
    expect(bare.stdout).toBe((await runCli(["customer", "--help"])).stdout);
  });

  it("keeps an unknown operation an error", async () => {
    const { exitCode, stderr } = await runCli(["customer", "no-such-operation"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown command");
  });
});

describe("built-in command help", () => {
  const builtins = [
    [], ["auth", "add"], ["auth", "remove"], ["auth", "rename"], ["listen"], ["docs"],
    ["skills"], ["skills", "add"], ["open"], ["feedback"], ["alias"], ["telemetry"], ["update"],
    ["resources"],
  ];

  it("fits every line in an 80-column terminal", async () => {
    for (const args of builtins) {
      const { stdout, exitCode } = await runCli([...args, "--help"]);
      expect(exitCode).toBe(0);
      const long = stdout.split("\n").filter((l) => [...l].length > 80);
      expect({ command: args.join(" "), long }).toEqual({ command: args.join(" "), long: [] });
    }
  });

  it("documents the alias actions and default name", async () => {
    const { stdout } = await runCli(["alias", "--help"]);
    expect(stdout).toMatch(/action\s+set, remove, or show/);
    expect(stdout).toMatch(/name\s+Alias name \(default: cb\)/);
    expect(stdout).toContain("\nEXAMPLES\n  chargebee alias set\n");
  });
});

describe("formatColumns", () => {
  it("returns an empty list for no items", () => {
    expect(formatColumns([])).toEqual([]);
  });
});

describe("chargebee resources", () => {
  it("lists callable resources and omits schema-only stubs", async () => {
    const { stdout, exitCode } = await runCli(["resources"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("customer");
    expect(stdout).toContain("subscription");
    expect(stdout).toContain("chargebee <resource> --help");
    expect(stdout).not.toContain("token");
    expect(stdout).not.toMatch(/\bcontact\b/);
  });

  it("prints the registry count and public docs do not say 100+", async () => {
    const registry = readFileSync(
      join(repoRoot, "src/commands/generated/registry.ts"),
      "utf8",
    );
    const generated = [...registry.matchAll(/^\s+register[A-Z]\w+\(rootCmd\);/gm)]
      .length;
    expect(generated).toBeGreaterThan(0);

    const { stdout, exitCode } = await runCli(["resources"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`API resources (${generated}):`);

    for (const rel of ["README.md", "CONTRIBUTING.md"]) {
      const text = readFileSync(join(repoRoot, rel), "utf8");
      expect(text).not.toContain("100+");
    }
  });

  it("documents an uninstall path for every install channel and how to drop local state", async () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    expect(readme).toContain("## Uninstall");
    expect(readme).toContain("npm uninstall -g @chargebee/cli");
    expect(readme).toContain('rm "$(command -v chargebee)"');
    expect(readme).toContain("Remove-Item (Get-Command chargebee).Source");
    expect(readme).toContain("~/.chargebee/cli");

    const commandsRef = readFileSync(
      join(repoRoot, "src/lib/skills/content/references/commands.md"),
      "utf8",
    );
    expect(commandsRef).toMatch(/chargebee skills .*remove/);
    expect(commandsRef).toMatch(/chargebee alias .*remove/);
  });
});

describe("operation help", () => {
  it("documents the actual customer identifier on retrieve", async () => {
    const { stdout, exitCode } = await runCli([
      "customer",
      "retrieve",
      "--help",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[customer-id]");
    expect(stdout).toContain("unique identifier of the customer");
    expect(stdout).toContain("--code-sample");
    expect(stdout).not.toContain("Commander.js convention");
  });

  it("shows the customer argument and docs pointer for subscription creation", async () => {
    const { stdout, exitCode } = await runCli(["subscription", "create-with-items", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("[customer-id]");
    expect(stdout).toContain("existing customer using item prices");
    expect(stdout).toContain("chargebee docs subscription create-with-items");
    expect(stdout).not.toContain("EXAMPLE");
    expect(stdout).not.toMatch(/PC1|PC2|pc-version|catalog|may be omitted|Required unless|Replace cust_123/);
  });

  it("uses subscription-id for retrieving subscriptions and in missing-argument errors", async () => {
    const help = await runCli(["subscription", "retrieve", "--help"]);
    expect(help.stdout).toContain("[subscription-id]");
    const result = await runCli(["subscription", "retrieve"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing required argument 'subscription-id'");
  });

  it("omits catalog flags from root help while keeping the override functional", async () => {
    const root = await runCli(["--help"]);
    expect(root.stdout).not.toContain("--pc-version");
    const sample = await runCli(["customer", "create", "--pc-version", "v2", "--code-sample", "python"]);
    expect(sample.exitCode).toBe(0);
    expect(sample.stdout).toContain("from chargebee import Chargebee");
  });

  it("passes positional IDs into samples without invoking the SDK or leaking configured credentials", async () => {
    const constructions: ClientConstruction[] = [];
    const customerRetrieveCalls: string[] = [];
    installFakeClient({ constructions, customerRetrieveCalls });
    env.set("CHARGEBEE_SITE", "acme-test");
    env.set("CHARGEBEE_API_KEY", "configured_api_key_must_not_leak");

    const retrieve = await runCli([
      "customer", "retrieve", "cus_demo", "--code-sample", "curl",
    ]);
    expect(retrieve.exitCode).toBe(0);
    expect(retrieve.stdout).toContain("/customers/cus_demo");
    expect(retrieve.stdout).not.toContain("{customer-id}");
    expect(retrieve.stdout).not.toContain("configured_api_key_must_not_leak");
    expect(retrieve.stdout).toContain("test_api_key");

    const update = await runCli([
      "customer", "update", "cus_demo", "-d", "email=ada@example.com",
      "--code-sample", "python",
    ]);
    expect(update.exitCode).toBe(0);
    expect(update.stdout).toContain('Customer.update("cus_demo"');
    expect(update.stdout).toContain('email="ada@example.com"');
    expect(update.stdout).not.toContain("configured_api_key_must_not_leak");
    expect(constructions).toEqual([]);
    expect(customerRetrieveCalls).toEqual([]);
  });

  it("parses rendered examples from generated help and exercises them through the fake SDK", async () => {
    const commands = [
      "customer create", "customer list", "customer retrieve", "customer update",
      "subscription create-with-items", "subscription list", "subscription retrieve",
      "invoice list", "invoice retrieve", "item-family create", "item-family list",
      "item-family retrieve", "item create", "item list", "item retrieve",
      "item-price create", "item-price list", "item-price retrieve",
    ];
    let examplesExecuted = 0;
    for (const command of commands) {
      const [resource, operation] = command.split(" ");
      const help = await runCli([resource, operation, "--help"]);
      expect(help.exitCode).toBe(0);
      const parsed = parseHelpExample(help.stdout);
      if (!parsed) continue; // The current published spec may not provide safe values.
      examplesExecuted++;
      const args = parsed.map((arg) => /^<[^>]+>$/.test(arg) ? "cust_example" : arg);
      expect(args[0]).toBe(command.split(" ")[0]);
      expect(help.stdout).toContain("EXAMPLE");
      env.set("CHARGEBEE_SITE", "acme-test");
      env.set("CHARGEBEE_API_KEY", "test_key");
      const camel = (value: string) => value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const calls: unknown[][] = [];
      __setClientFactory(() => ({
        [camel(resource)]: { [camel(operation)]: async (...params: unknown[]) => {
          calls.push(params);
          return {};
        } },
      }) as never);
      const result = await runCli(args);
      expect(result.exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      const positional = args[2];
      if (positional && positional !== "-d") expect(calls[0][0]).toBe(positional);
      const sample = await runCli([...args, "--code-sample", "python"]);
      expect(sample.exitCode).toBe(0);
      expect(sample.stdout).toContain("from chargebee import Chargebee");
      expect(calls).toHaveLength(1); // Code generation must not execute the API call.
    }
    expect(examplesExecuted).toBeGreaterThan(0);
  });

  it("omits create examples when the specs do not provide safe request values", async () => {
    for (const [resource, operation] of [["subscription", "create-with-items"], ["item-family", "create"]]) {
      const { stdout, exitCode } = await runCli([resource, operation, "--help"]);
      expect(exitCode).toBe(0);
      expect(stdout).not.toContain("EXAMPLE");
    }
  });
});
