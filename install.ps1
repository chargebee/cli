#Requires -Version 5.1
<#
.SYNOPSIS
  Install the Chargebee CLI Windows binary (no Node required).

.DESCRIPTION
  Downloads chargebee-cli-windows-x64.exe from GitHub Releases, saves it as
  chargebee.exe under %LOCALAPPDATA%\Chargebee\bin, and adds that folder to
  the user PATH.

  CI snapshot (no GitHub download):
    CHARGEBEE_CLI_INSTALL_FILE  - path to a compiled .exe
    CHARGEBEE_CLI_BIN_DIR       - install prefix (also skips mutating user PATH)
  Pin a release instead of latest:
    CHARGEBEE_CLI_VERSION       - release tag, e.g. v1.2.3
#>
$ErrorActionPreference = "Stop"
# The default progress bar is an order of magnitude slower than the download
# itself on Windows PowerShell 5.1.
$ProgressPreference = "SilentlyContinue"

$Repo = "chargebee/cli"
$AssetName = "chargebee-cli-windows-x64.exe"
$BinName = "chargebee.exe"

# A token lets this script resolve a private repo's release assets through
# the API (the plain releases/download/ URL only works for a public repo).
$Token = if ($env:GH_TOKEN) { $env:GH_TOKEN } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { $null }

$onWindows = ($env:OS -eq "Windows_NT") -or ($IsWindows -eq $true)
if (-not $onWindows) {
  throw "install.ps1 is for Windows. macOS/Linux: curl -fsSL https://raw.githubusercontent.com/$Repo/main/install.sh | bash"
}

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq "ARM64") {
  throw "Windows ARM64 is not supported yet; use npm: npm install -g @chargebee/cli"
}
if ($arch -ne "AMD64") {
  throw "Unsupported architecture: $arch (need x64). This installer ships chargebee-cli-windows-x64.exe only."
}

function Test-EnvOn([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return $false }
  switch ($value.Trim().ToLowerInvariant()) {
    "0" { return $false }
    "false" { return $false }
    "no" { return $false }
    default { return $true }
  }
}

if ($env:CHARGEBEE_CLI_BIN_DIR) {
  $binDir = $env:CHARGEBEE_CLI_BIN_DIR
} else {
  $binDir = Join-Path $env:LOCALAPPDATA "Chargebee\bin"
}
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$dest = Join-Path $binDir $BinName
$prev = $null
$existing = Get-Command chargebee -ErrorAction SilentlyContinue
if ($existing) {
  try { $prev = (& chargebee --version 2>$null | Select-Object -First 1) } catch { $prev = $null }
}

if ($prev) {
  Write-Host "Updating chargebee CLI ($prev → latest)..."
} else {
  Write-Host "Installing chargebee CLI for windows/x64..."
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("chargebee-install-" + [guid]::NewGuid().ToString("N") + ".exe")
try {
  if ($env:CHARGEBEE_CLI_INSTALL_FILE) {
    if (-not (Test-Path -LiteralPath $env:CHARGEBEE_CLI_INSTALL_FILE -PathType Leaf)) {
      throw "CHARGEBEE_CLI_INSTALL_FILE is not a file: $($env:CHARGEBEE_CLI_INSTALL_FILE)"
    }
    Copy-Item -LiteralPath $env:CHARGEBEE_CLI_INSTALL_FILE -Destination $tmp -Force
  } else {
    if ($env:CHARGEBEE_CLI_VERSION) {
      $tag = $env:CHARGEBEE_CLI_VERSION.Trim()
      if (-not $tag.StartsWith("v")) { $tag = "v$tag" }
    } else {
      # Default to stable; a prerelease requires an explicit version pin.
      $apiUrl = "https://api.github.com/repos/$Repo/releases/latest"
      $apiHeaders = @{ Accept = "application/vnd.github+json"; "User-Agent" = "chargebee-cli-installer" }
      if ($Token) { $apiHeaders["Authorization"] = "Bearer $Token" }
      $tag = $null
      try {
        $release = Invoke-RestMethod -Uri $apiUrl -Headers $apiHeaders -UseBasicParsing
        if (-not $release.draft -and -not $release.prerelease) { $tag = $release.tag_name }
      } catch {
        $tag = $null
      }
      if ([string]::IsNullOrWhiteSpace($tag) -or $tag.Contains("-")) {
        throw "Could not resolve the latest stable release of $Repo. Pin one with CHARGEBEE_CLI_VERSION=vX.Y.Z or see https://github.com/$Repo/releases"
      }
    }

    # The plain releases/download/ URL only serves a public repo. With a
    # token, resolve both assets through the release-by-tag API instead,
    # which works for a private repo too.
    $url = "https://github.com/$Repo/releases/download/$tag/$AssetName"
    $sumsUrl = "https://github.com/$Repo/releases/download/$tag/SHA256SUMS.txt"
    $downloadHeaders = @{ Accept = "application/octet-stream" }
    if ($Token) {
      $downloadHeaders["Authorization"] = "Bearer $Token"
      try {
        $tagHeaders = @{ Accept = "application/vnd.github+json"; "User-Agent" = "chargebee-cli-installer"; Authorization = "Bearer $Token" }
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$tag" -Headers $tagHeaders -UseBasicParsing
        $assetMatch = $release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
        if ($assetMatch) { $url = $assetMatch.url }
        $sumsMatch = $release.assets | Where-Object { $_.name -eq "SHA256SUMS.txt" } | Select-Object -First 1
        if ($sumsMatch) { $sumsUrl = $sumsMatch.url }
      } catch {
        # Fall back to the public URLs already set above.
      }
    }

    try {
      Invoke-WebRequest -Uri $url -OutFile $tmp -Headers $downloadHeaders -UseBasicParsing
    } catch {
      throw "Failed to download $AssetName. See https://github.com/$Repo/releases"
    }

    if (Test-EnvOn $env:CHARGEBEE_CLI_SKIP_CHECKSUM) {
      Write-Host "Warning: skipping checksum verification (CHARGEBEE_CLI_SKIP_CHECKSUM=1)"
    } else {
      $sumsFile = Join-Path ([System.IO.Path]::GetTempPath()) ("chargebee-sums-" + [guid]::NewGuid().ToString("N") + ".txt")
      try {
        try {
          Invoke-WebRequest -Uri $sumsUrl -OutFile $sumsFile -Headers $downloadHeaders -UseBasicParsing
        } catch {
          throw "Could not download SHA256SUMS.txt for $tag. Set CHARGEBEE_CLI_SKIP_CHECKSUM=1 to skip verification (not recommended)."
        }
        $expectedLine = Select-String -LiteralPath $sumsFile -Pattern ([regex]::Escape($AssetName)) | Select-Object -First 1
        if (-not $expectedLine) {
          throw "SHA256SUMS.txt has no entry for $AssetName. Set CHARGEBEE_CLI_SKIP_CHECKSUM=1 to skip verification (not recommended)."
        }
        $expectedHash = ($expectedLine.Line -split '\s+')[0].ToLowerInvariant()
        $actualHash = (Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
          throw "Checksum verification failed for $AssetName. Set CHARGEBEE_CLI_SKIP_CHECKSUM=1 to skip verification (not recommended)."
        }
      } finally {
        if (Test-Path -LiteralPath $sumsFile) { Remove-Item -LiteralPath $sumsFile -Force -ErrorAction SilentlyContinue }
      }
    }
  }

  Copy-Item -LiteralPath $tmp -Destination $dest -Force
} finally {
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}

$markerDir = if ($env:CHARGEBEE_CONFIG_DIR) { $env:CHARGEBEE_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".chargebee\cli" }
New-Item -ItemType Directory -Force -Path $markerDir | Out-Null
Set-Content -LiteralPath (Join-Path $markerDir "install-method") -Value "github" -Encoding ascii

if (-not $env:CHARGEBEE_CLI_BIN_DIR) {
  # Read/write the raw registry value (not [Environment]::Get/SetEnvironmentVariable,
  # which round-trip through the expanded string) so an existing %USERPROFILE%-style
  # entry, and the REG_EXPAND_SZ value type itself, survive unchanged.
  $rawUserPath = (Get-Item HKCU:\Environment).GetValue("Path", "", "DoNotExpandEnvironmentNames")
  $expandedParts = @()
  if ($rawUserPath) {
    $expandedParts = $rawUserPath -split ";" | Where-Object { $_ } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd("\") }
  }
  if ($expandedParts -notcontains $binDir.TrimEnd("\")) {
    $newRawPath = if ($rawUserPath) { "$rawUserPath;$binDir" } else { $binDir }
    Set-ItemProperty -Path "HKCU:\Environment" -Name "Path" -Value $newRawPath -Type ExpandString
    # Broadcast WM_SETTINGCHANGE so Explorer reloads its environment and terminals opened from it see the new PATH; best-effort.
    try {
      $signature = '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
      $user32 = Add-Type -MemberDefinition $signature -Name "NativeMethods" -Namespace "ChargebeeInstaller" -PassThru
      $broadcastResult = [UIntPtr]::Zero
      [void]$user32::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$broadcastResult)
    } catch { }
    Write-Host ""
    Write-Host "  Added $binDir to your user PATH. Open a new terminal for 'chargebee' to resolve."
  }
  # Plain substring match, not -like/-notlike: $binDir can contain wildcard
  # characters ([, ], *) that would otherwise be interpreted as a pattern.
  if ($env:Path.IndexOf($binDir, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
    $env:Path = "$binDir;$env:Path"
  }
}

$newVersion = $null
try { $newVersion = (& $dest --version 2>$null | Select-Object -First 1) } catch { $newVersion = $null }
if ($prev) {
  Write-Host "Updated: $prev → $(if ($newVersion) { $newVersion } else { 'done' })"
} else {
  Write-Host "Installed: $(if ($newVersion) { $newVersion } else { 'chargebee' }) → $dest"
}

function Test-OnboardingPrompt {
  if (Test-EnvOn $env:CI) { return $false }
  if (Test-EnvOn $env:CHARGEBEE_CLI_NO_ONBOARDING) { return $false }
  return [Environment]::UserInteractive
}

function Read-YesNo([string]$question) {
  $reply = Read-Host "$question [Y/n]"
  if ([string]::IsNullOrWhiteSpace($reply)) { return $true }
  return ($reply.Trim().ToLowerInvariant() -in @("y", "yes"))
}

if (Test-OnboardingPrompt) {
  Write-Host ""
  if (Read-YesNo "Install the Chargebee CLI skill for all detected coding agents?") {
    # --path treats the home directory as a project and puts Codex skills in
    # the wrong scope. The answer above authorizes all detected global targets.
    & $dest skills add --global --yes
  } else {
    Write-Host "  Later: chargebee skills add --global"
  }
  if (Read-YesNo "Add a cb shortcut for the chargebee command?") {
    # Tell the CLI which profile this PowerShell edition actually loads.
    $prevProfileEnv = $env:CHARGEBEE_CLI_POWERSHELL_PROFILE
    $env:CHARGEBEE_CLI_POWERSHELL_PROFILE = $PROFILE
    try { & $dest alias set } finally { $env:CHARGEBEE_CLI_POWERSHELL_PROFILE = $prevProfileEnv }
  } else {
    Write-Host "  Later: chargebee alias set"
  }
  Set-Content -LiteralPath (Join-Path $markerDir "onboarding.json") -Value '{"offered":true}' -Encoding ascii
} else {
  Write-Host ""
  Write-Host "  Using an AI agent? Install the Chargebee CLI skill:"
  Write-Host "    chargebee skills add --global"
  Write-Host "  Prefer a shorter command?"
  Write-Host "    chargebee alias set"
}

Write-Host ""
Write-Host "Get started:"
Write-Host "  chargebee auth add"
