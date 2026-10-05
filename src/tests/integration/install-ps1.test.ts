/**
 * install.ps1 is Windows-only. Assert the OS guard sits before any download.
 * Spawning pwsh on Linux CI hangs (cold start vs bun's 5s test timeout).
 * The real Windows snapshot lives in install-smoke.yml.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "../../../install.ps1"), "utf8");

describe("install.ps1", () => {
  it("refuses to run off Windows before downloading", () => {
    const guard = src.indexOf("if (-not $onWindows)");
    const download = src.indexOf("Invoke-WebRequest");
    expect(guard).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(guard);
    expect(src).toContain("install.ps1 is for Windows");
  });

  it("defaults to the stable release endpoint", () => {
    expect(src).toContain('"https://api.github.com/repos/$Repo/releases/latest"');
    expect(src).toContain("Invoke-RestMethod");
    expect(src).toContain("$release.tag_name");
    expect(src).toContain("-not $release.prerelease");
    expect(src).toContain('"https://github.com/$Repo/releases/download/$tag/$AssetName"');
    expect(src).not.toContain("/releases/latest/");
  });

  it("verifies the downloaded asset against SHA256SUMS.txt before installing it", () => {
    expect(src).toContain('"https://github.com/$Repo/releases/download/$tag/SHA256SUMS.txt"');
    expect(src).toContain("Get-FileHash");
    expect(src).toContain("-Algorithm SHA256");
    expect(src).toContain("CHARGEBEE_CLI_SKIP_CHECKSUM");
    expect(src).toContain("Checksum verification failed");
    const hashCheck = src.indexOf("Get-FileHash");
    const copyToDest = src.indexOf("Copy-Item -LiteralPath $tmp -Destination $dest");
    expect(hashCheck).toBeGreaterThan(-1);
    expect(copyToDest).toBeGreaterThan(hashCheck);
  });

  it("persists the user PATH through the registry, preserving REG_EXPAND_SZ", () => {
    expect(src).toContain("DoNotExpandEnvironmentNames");
    expect(src).toContain("-Type ExpandString");
    expect(src).toContain('Set-ItemProperty -Path "HKCU:\\Environment" -Name "Path"');
    expect(src).not.toContain("SetEnvironmentVariable(\"Path\", $newPath, \"User\")");
    expect(src).not.toMatch(/SetEnvironmentVariable\(\s*["']Path["'],[^)]*["']User["']\s*\)/);
  });

  it("broadcasts WM_SETTINGCHANGE after writing the user PATH instead of relying on SetEnvironmentVariable", () => {
    expect(src).toContain("WM_SETTINGCHANGE");
    expect(src).toContain("SendMessageTimeout");
    expect(src).not.toContain("SetEnvironmentVariable(");
    const registryWrite = src.indexOf('Set-ItemProperty -Path "HKCU:\\Environment" -Name "Path"');
    const broadcast = src.indexOf("SendMessageTimeout(");
    expect(registryWrite).toBeGreaterThan(-1);
    expect(broadcast).toBeGreaterThan(registryWrite);
  });

  it("silences the download progress bar (slow on Windows PowerShell 5.1)", () => {
    const pref = src.indexOf('$ProgressPreference = "SilentlyContinue"');
    const download = src.indexOf("Invoke-WebRequest -Uri $url");
    expect(pref).toBeGreaterThan(-1);
    expect(pref).toBeLessThan(download);
  });

  it("throws instead of a dead exit after Write-Error under $ErrorActionPreference = Stop", () => {
    expect(src).not.toContain("Write-Error");
    expect(src).not.toMatch(/\bexit 1\b/);
    expect(src).toContain('throw "install.ps1 is for Windows');
  });

  it("gives ARM64 a clear, actionable message instead of a generic unsupported-arch error", () => {
    const arm64Check = src.indexOf('$arch -eq "ARM64"');
    const genericCheck = src.indexOf('$arch -ne "AMD64"');
    expect(arm64Check).toBeGreaterThan(-1);
    expect(genericCheck).toBeGreaterThan(arm64Check);
    expect(src).toContain("Windows ARM64 is not supported yet; use npm: npm install -g @chargebee/cli");
  });

  it("matches the current process PATH with a plain substring check, not a -like wildcard pattern", () => {
    expect(src).not.toContain('-notlike "*$binDir*"');
    expect(src).toContain("$env:Path.IndexOf($binDir");
  });

  it("hands the running PowerShell's $PROFILE to `alias set` so the alias lands in the active edition's profile", () => {
    const setEnv = src.indexOf("$env:CHARGEBEE_CLI_POWERSHELL_PROFILE = $PROFILE");
    const aliasSet = src.indexOf("& $dest alias set");
    expect(setEnv).toBeGreaterThan(-1);
    expect(aliasSet).toBeGreaterThan(setEnv);
  });

  it("resolves release assets through the authenticated API when a token is available", () => {
    expect(src).toContain('$Token = if ($env:GH_TOKEN) { $env:GH_TOKEN } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { $null }');
    expect(src).toContain('"https://api.github.com/repos/$Repo/releases/tags/$tag"');
    expect(src).toContain('Authorization = "Bearer $Token"');
    expect(src).toContain('$downloadHeaders["Authorization"] = "Bearer $Token"');
    const tokenCheck = src.indexOf("if ($Token) {");
    const download = src.indexOf("Invoke-WebRequest -Uri $url -OutFile $tmp");
    expect(tokenCheck).toBeGreaterThan(-1);
    expect(download).toBeGreaterThan(tokenCheck);
  });
});
