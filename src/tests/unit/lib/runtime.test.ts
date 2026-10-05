import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isCompiledBinary, resolveEntryScript } from "../../../lib/runtime.js";

describe("runtime detection", () => {
  let dir: string;
  let script: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cb-runtime-"));
    script = join(dir, "lib", "node_modules", "@chargebee", "cli", "dist", "index.js");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, "#!/usr/bin/env node\n");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("isCompiledBinary", () => {
    const runtimeShapes = [
      "/usr/bin/nodejs",
      "/usr/bin/node",
      "/usr/local/bin/node22",
      "/home/bob/.nvm/versions/node/v22.4.0/bin/node",
      "C:\\Program Files\\nodejs\\node.exe",
      "/usr/local/bin/bun",
      // A runtime whose file name looks nothing like a runtime is still a
      // runtime when it is running an entry script that exists on disk.
      "/home/bunny/.local/bin/chargebee",
    ];
    for (const execPath of runtimeShapes) {
      it(`is false for ${execPath} running a script`, () => {
        expect(isCompiledBinary({ execPath, argv: [execPath, script, "ping"] })).toBe(false);
      });
    }

    it("is false when argv[1] is the npm bin symlink to the entry script", () => {
      const bin = join(dir, "bin", "chargebee");
      mkdirSync(dirname(bin), { recursive: true });
      symlinkSync(script, bin);
      expect(isCompiledBinary({ execPath: "/usr/bin/nodejs", argv: ["/usr/bin/nodejs", bin] })).toBe(false);
    });

    it("is true for a Bun-compiled binary (argv[1] is the /$bunfs/ virtual entry)", () => {
      const execPath = "/home/bunny/.local/bin/chargebee";
      expect(isCompiledBinary({ execPath, argv: [execPath, "/$bunfs/root/chargebee-cli", "ping"] })).toBe(true);
    });

    it("is true for a Bun-compiled .exe on Windows (argv[1] is the B:\\~BUN\\ virtual entry)", () => {
      const execPath = "C:\\Users\\bob\\AppData\\Local\\Chargebee\\bin\\chargebee.exe";
      expect(isCompiledBinary({ execPath, argv: [execPath, "B:\\~BUN\\root\\chargebee-cli"] })).toBe(true);
    });

    it("is true when argv[1] equals execPath", () => {
      const execPath = join(dir, "bin", "chargebee");
      mkdirSync(dirname(execPath), { recursive: true });
      writeFileSync(execPath, "");
      expect(isCompiledBinary({ execPath, argv: [execPath, execPath] })).toBe(true);
    });

    it("is true when there is no argv[1]", () => {
      expect(isCompiledBinary({ execPath: "/opt/nodeapps/chargebee", argv: ["/opt/nodeapps/chargebee"] })).toBe(true);
    });

    it("is true when argv[1] does not resolve on disk", () => {
      const execPath = "/opt/nodeapps/chargebee";
      expect(isCompiledBinary({ execPath, argv: [execPath, join(dir, "missing-entry")] })).toBe(true);
    });

    it("defaults to the current process", () => {
      expect(isCompiledBinary()).toBe(isCompiledBinary(process));
    });
  });

  describe("resolveEntryScript", () => {
    it("returns the real path of the entry script for a runtime + script process", () => {
      const bin = join(dir, "bin", "chargebee");
      mkdirSync(dirname(bin), { recursive: true });
      symlinkSync(script, bin);
      expect(resolveEntryScript({ execPath: "/usr/bin/node22", argv: ["/usr/bin/node22", bin] })).toBe(realpathSync(script));
    });

    it("returns null for a compiled binary", () => {
      const execPath = "/home/bob/bin/chargebee";
      expect(resolveEntryScript({ execPath, argv: [execPath, "/$bunfs/root/chargebee-cli"] })).toBeNull();
      expect(resolveEntryScript({ execPath, argv: [execPath] })).toBeNull();
    });
  });
});
