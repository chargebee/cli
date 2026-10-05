import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __setPlatformForTest,
  detectShellTarget,
  isAliasSupported,
  removeAlias,
  setAlias,
  showAlias,
} from "../../../lib/alias.js";
import { createEnvPatcher } from "../../../lib/test-support/_helpers.js";

describe("detectShellTarget", () => {
  const env = createEnvPatcher();
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cb-alias-detect-"));
    env.set("HOME", home);
  });

  afterEach(() => {
    env.restore();
    __setPlatformForTest(null);
    rmSync(home, { recursive: true, force: true });
  });

  const cases: Array<{
    name: string;
    shell: string | undefined;
    platform: NodeJS.Platform;
    expectedShell: "bash" | "zsh" | "fish" | "powershell" | null;
    expectedFile: (home: string) => string;
  }> = [
    {
      name: "zsh",
      shell: "/bin/zsh",
      platform: "linux",
      expectedShell: "zsh",
      expectedFile: (h) => join(h, ".zshrc"),
    },
    {
      name: "bash on linux",
      shell: "/bin/bash",
      platform: "linux",
      expectedShell: "bash",
      expectedFile: (h) => join(h, ".bashrc"),
    },
    {
      name: "fish",
      shell: "/usr/bin/fish",
      platform: "linux",
      expectedShell: "fish",
      expectedFile: (h) => join(h, ".config", "fish", "conf.d", "chargebee.fish"),
    },
    {
      name: "unset SHELL",
      shell: undefined,
      platform: "linux",
      expectedShell: null,
      expectedFile: () => "",
    },
    {
      name: "nushell",
      shell: "/usr/bin/nu",
      platform: "linux",
      expectedShell: null,
      expectedFile: () => "",
    },
    {
      name: "win32 with SHELL unset",
      shell: undefined,
      platform: "win32",
      expectedShell: "powershell",
      expectedFile: (h) =>
        join(h, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
    },
    {
      name: "win32 with a non-POSIX SHELL",
      shell: "C:\\Windows\\System32\\cmd.exe",
      platform: "win32",
      expectedShell: "powershell",
      expectedFile: (h) =>
        join(h, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
    },
    {
      name: "win32 under Git Bash (SHELL=/usr/bin/bash)",
      shell: "/usr/bin/bash",
      platform: "win32",
      expectedShell: "bash",
      expectedFile: (h) => join(h, ".bashrc"),
    },
  ];

  for (const c of cases) {
    it(`resolves ${c.name}`, () => {
      env.set("SHELL", c.shell);
      __setPlatformForTest(c.platform);
      const target = detectShellTarget();
      if (c.expectedShell === null) {
        expect(target).toBeNull();
        expect(isAliasSupported()).toBe(false);
      } else {
        expect(target?.shell).toBe(c.expectedShell);
        expect(target?.file).toBe(c.expectedFile(home));
        expect(isAliasSupported()).toBe(true);
      }
    });
  }

  // Bash login shells read only the first of these that exists, so the alias
  // goes into whichever file already owns the user's login setup.
  const darwinBashCases: Array<{ existing: string[]; expected: string }> = [
    { existing: [], expected: ".bash_profile" },
    { existing: [".bash_profile"], expected: ".bash_profile" },
    { existing: [".bash_login"], expected: ".bash_login" },
    { existing: [".profile"], expected: ".profile" },
    { existing: [".bash_login", ".profile"], expected: ".bash_login" },
    { existing: [".bash_profile", ".bash_login", ".profile"], expected: ".bash_profile" },
  ];

  for (const c of darwinBashCases) {
    const label = c.existing.length ? c.existing.join(" + ") : "no login file";
    it(`uses ~/${c.expected} on macOS bash without ~/.bashrc when ${label} exists`, () => {
      env.set("SHELL", "/bin/bash");
      __setPlatformForTest("darwin");
      for (const f of c.existing) writeFileSync(join(home, f), "");
      const target = detectShellTarget();
      expect(target?.file).toBe(join(home, c.expected));
    });
  }

  it("keeps ~/.bashrc on macOS when it already exists", () => {
    env.set("SHELL", "/bin/bash");
    __setPlatformForTest("darwin");
    writeFileSync(join(home, ".bashrc"), "");
    const target = detectShellTarget();
    expect(target?.file).toBe(join(home, ".bashrc"));
  });

  describe("PowerShell profile selection", () => {
    const ps7Profile = (h: string) =>
      join(h, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
    const ps5Profile = (h: string) =>
      join(h, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");

    beforeEach(() => {
      env.set("SHELL", undefined);
      __setPlatformForTest("win32");
      // A PATH with no pwsh on it, and no explicit profile, unless a test says otherwise.
      mkdirSync(join(home, "bin-without-pwsh"), { recursive: true });
      env.set("PATH", join(home, "bin-without-pwsh"));
      env.set("PATHEXT", ".COM;.EXE;.BAT;.CMD");
      env.set("CHARGEBEE_CLI_POWERSHELL_PROFILE", undefined);
    });

    it("uses CHARGEBEE_CLI_POWERSHELL_PROFILE when it is set to an absolute path", () => {
      const explicit = join(home, "OneDrive", "Documents", "PowerShell", "profile.ps1");
      env.set("CHARGEBEE_CLI_POWERSHELL_PROFILE", explicit);
      mkdirSync(join(home, "bin-with-pwsh"), { recursive: true });
      writeFileSync(join(home, "bin-with-pwsh", "pwsh.exe"), "");
      env.set("PATH", join(home, "bin-with-pwsh"));
      expect(detectShellTarget()).toEqual({ shell: "powershell", file: explicit });
    });

    it("ignores a relative CHARGEBEE_CLI_POWERSHELL_PROFILE", () => {
      env.set("CHARGEBEE_CLI_POWERSHELL_PROFILE", "profile.ps1");
      expect(detectShellTarget()?.file).toBe(ps5Profile(home));
    });

    it("prefers the PowerShell 7 profile when pwsh is on PATH, even before its dir exists", () => {
      mkdirSync(join(home, "no-pwsh-here"), { recursive: true });
      mkdirSync(join(home, "bin-with-pwsh"), { recursive: true });
      writeFileSync(join(home, "bin-with-pwsh", "pwsh.exe"), "");
      env.set("PATH", [join(home, "no-pwsh-here"), join(home, "bin-with-pwsh")].join(";"));
      expect(detectShellTarget()?.file).toBe(ps7Profile(home));
      expect(existsSync(join(home, "Documents"))).toBe(false);
    });

    it("only counts pwsh with an extension listed in PATHEXT", () => {
      mkdirSync(join(home, "bin-with-pwsh"), { recursive: true });
      writeFileSync(join(home, "bin-with-pwsh", "pwsh.exe"), "");
      env.set("PATH", join(home, "bin-with-pwsh"));
      env.set("PATHEXT", ".COM;.BAT");
      expect(detectShellTarget()?.file).toBe(ps5Profile(home));
    });

    it("falls back to the Windows PowerShell profile when pwsh is not on PATH", () => {
      expect(detectShellTarget()?.file).toBe(ps5Profile(home));
    });

    it("still picks the PowerShell 7 profile when only its dir exists", () => {
      mkdirSync(join(home, "Documents", "PowerShell"), { recursive: true });
      expect(detectShellTarget()?.file).toBe(ps7Profile(home));
    });
  });
});

describe("setAlias per shell", () => {
  const env = createEnvPatcher();
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cb-alias-set-"));
    env.set("HOME", home);
  });

  afterEach(() => {
    env.restore();
    __setPlatformForTest(null);
    rmSync(home, { recursive: true, force: true });
  });

  it("writes a fish function to conf.d", async () => {
    env.set("SHELL", "/usr/bin/fish");
    __setPlatformForTest("linux");
    await setAlias("cbx");
    const file = join(home, ".config", "fish", "conf.d", "chargebee.fish");
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("function cbx;");
    expect(content).toContain("# chargebee-cli alias");
  });

  it("writes a Set-Alias line to the Windows PowerShell profile", async () => {
    env.set("SHELL", undefined);
    __setPlatformForTest("win32");
    await setAlias("cbx");
    const file = join(
      home,
      "Documents",
      "WindowsPowerShell",
      "Microsoft.PowerShell_profile.ps1",
    );
    const content = readFileSync(file, "utf-8");
    // Single quotes keep `$` and spaces in the binary path literal.
    expect(content).toContain("Set-Alias cbx 'chargebee'");
    expect(content).toContain("# chargebee-cli alias");
  });

  it("replaces an owned line whose target is stale", async () => {
    env.set("SHELL", "/bin/zsh");
    __setPlatformForTest("linux");
    const file = join(home, ".zshrc");
    writeFileSync(file, "export A=1\nalias cbx='/old/chargebee'  # chargebee-cli alias\nexport B=2\n");
    await setAlias("cbx");
    expect(readFileSync(file, "utf-8")).toBe(
      "export A=1\nalias cbx='chargebee'  # chargebee-cli alias\nexport B=2\n",
    );
  });

  it("remove matches the whole name, so `cb` leaves an owned `cb-x` alone", async () => {
    env.set("SHELL", "/usr/bin/fish");
    __setPlatformForTest("linux");
    await setAlias("cb-x");
    const file = join(home, ".config", "fish", "conf.d", "chargebee.fish");
    await removeAlias("cb");
    expect(readFileSync(file, "utf-8")).toContain("function cb-x;");

    env.set("SHELL", undefined);
    __setPlatformForTest("win32");
    await setAlias("cb-x");
    const profile = join(home, "Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1");
    await removeAlias("cb");
    expect(readFileSync(profile, "utf-8")).toContain("Set-Alias cb-x");
  });

  it("writes a bash alias line to ~/.bashrc under Git Bash on win32", async () => {
    env.set("SHELL", "/usr/bin/bash");
    __setPlatformForTest("win32");
    await setAlias("cbx");
    const content = readFileSync(join(home, ".bashrc"), "utf-8");
    expect(content).toContain("alias cbx='chargebee'  # chargebee-cli alias");
    expect(existsSync(join(home, "Documents"))).toBe(false);
  });

  // Root bypasses file permissions, so an unreadable rc file cannot be staged there.
  const notRoot = typeof process.getuid === "function" && process.getuid() !== 0;

  it.skipIf(!notRoot)("aborts without touching an rc file it cannot read", async () => {
    env.set("SHELL", "/bin/zsh");
    __setPlatformForTest("linux");
    const file = join(home, ".zshrc");
    const original = "export PATH=/custom/bin:$PATH\nalias ll='ls -l'\n";
    writeFileSync(file, original);
    chmodSync(file, 0o000);
    try {
      await expect(setAlias("cbx")).rejects.toThrow(/EACCES|EPERM|permission denied/i);
      expect(statSync(file).mode & 0o777).toBe(0o000);
      expect(existsSync(`${file}.chargebee-cli.bak`)).toBe(false);
      await expect(removeAlias("cbx")).rejects.toThrow(/EACCES|EPERM|permission denied/i);
    } finally {
      chmodSync(file, 0o600);
    }
    expect(readFileSync(file, "utf-8")).toBe(original);
  });

  it("prints instructions and writes nothing for an unsupported shell", async () => {
    env.set("SHELL", "/usr/bin/nu");
    __setPlatformForTest("linux");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await setAlias("cbx");
    } finally {
      console.log = origLog;
    }
    expect(logs.join("\n")).toContain("alias cbx=");
    expect(logs.join("\n")).toContain("Could not detect a supported shell");
    expect(existsSync(join(home, ".bashrc"))).toBe(false);
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
  });

  it("prints instructions and writes nothing for remove/show on an unsupported shell", async () => {
    env.set("SHELL", "/usr/bin/nu");
    __setPlatformForTest("linux");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await removeAlias("cbx");
      await showAlias();
    } finally {
      console.log = origLog;
    }
    expect(logs.join("\n")).toContain("Could not detect a supported shell");
    expect(existsSync(join(home, ".bashrc"))).toBe(false);
  });

  it("embeds the compiled binary path when execPath is not node/bun", async () => {
    env.set("SHELL", "/bin/zsh");
    __setPlatformForTest("linux");
    const orig = Object.getOwnPropertyDescriptor(process, "execPath");
    Object.defineProperty(process, "execPath", {
      value: "/usr/local/bin/chargebee-cli",
      configurable: true,
    });
    try {
      await setAlias("cbx");
    } finally {
      if (orig) Object.defineProperty(process, "execPath", orig);
    }
    const content = readFileSync(join(home, ".zshrc"), "utf-8");
    expect(content).toContain("alias cbx='/usr/local/bin/chargebee-cli'");
  });
});
