# Installs the codex-chatgpt-web CLI/runtime bridge from this repo checkout,
# without downloading a release asset. Mirrors scripts/install-local.sh, but
# for a plain Windows terminal (no WSL/git-bash required).
#
# Usage:
#   ./scripts/install-local.ps1 [-SkipBuild] [setup-args...]
#
# Env overrides (same names as install-local.sh):
#   CODEX_CHATGPT_WEB_BIN_DIR   (default: $env:LOCALAPPDATA\codex-chatgpt-web\bin)
#   CODEX_CHATGPT_WEB_LIB_DIR   (default: $env:LOCALAPPDATA\codex-chatgpt-web\lib)
#   CODEX_CHATGPT_WEB_DOC_DIR   (default: $env:LOCALAPPDATA\codex-chatgpt-web\doc)

param(
  [switch]$SkipBuild,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$SetupArgs
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
Push-Location $Root
try {
  $BinDir = if ($env:CODEX_CHATGPT_WEB_BIN_DIR) { $env:CODEX_CHATGPT_WEB_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "codex-chatgpt-web\bin" }
  $LibDir = if ($env:CODEX_CHATGPT_WEB_LIB_DIR) { $env:CODEX_CHATGPT_WEB_LIB_DIR } else { Join-Path $env:LOCALAPPDATA "codex-chatgpt-web\lib" }
  $DocDir = if ($env:CODEX_CHATGPT_WEB_DOC_DIR) { $env:CODEX_CHATGPT_WEB_DOC_DIR } else { Join-Path $env:LOCALAPPDATA "codex-chatgpt-web\doc" }
  $BuildDir = Join-Path $Root "dist\runtime"

  if (-not $SkipBuild -or -not (Test-Path $BuildDir)) {
    Write-Host "Building runtime bundle from $Root ..."
    & bun run build
    if ($LASTEXITCODE -ne 0) { throw "bun run build failed with code $LASTEXITCODE" }
  }

  $BuiltCli = Join-Path $BuildDir "bin\codex-chatgpt-web.cmd"
  $BuiltBun = Join-Path $BuildDir "runtime\bun.exe"
  $ManifestPath = Join-Path $BuildDir "manifest.json"
  if (-not (Test-Path $BuiltCli) -or -not (Test-Path $BuiltBun)) {
    throw "Runtime bundle at $BuildDir is incomplete; run without -SkipBuild"
  }
  if (-not (Test-Path $ManifestPath)) {
    throw "Runtime bundle at $BuildDir is missing manifest.json"
  }

  $Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
  $Version = [string]$Manifest.appVersion
  if (-not $Version) { throw "Could not read appVersion from $ManifestPath" }

  $BuiltVersion = (& $BuiltCli --version).Trim()
  if ($BuiltVersion -ne $Version) {
    throw "Built runtime version ($BuiltVersion) does not match manifest ($Version)"
  }

  $StageDir = Join-Path $LibDir ".stage-$Version-$PID"
  $TargetDir = Join-Path $LibDir $Version
  $BackupDir = Join-Path $LibDir ".previous-$Version-$PID"

  try {
    New-Item -ItemType Directory -Force -Path $LibDir, $BinDir, $DocDir | Out-Null
    if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
    Copy-Item $BuildDir $StageDir -Recurse

    $HadPrevious = $false
    if (Test-Path $TargetDir) {
      Move-Item $TargetDir $BackupDir
      $HadPrevious = $true
    }
    try {
      Move-Item $StageDir $TargetDir
    } catch {
      if ($HadPrevious) { Move-Item $BackupDir $TargetDir -Force }
      throw
    }

    # The .cmd wrapper resolves its install root from its own location (%~dp0..), and Windows
    # symlinks need elevation/Developer Mode, so BinDir gets a tiny shim that forwards to the
    # versioned copy instead of a symlink to it.
    $ShimPath = Join-Path $BinDir "codex-chatgpt-web.cmd"
    $TargetCli = Join-Path $TargetDir "bin\codex-chatgpt-web.cmd"
    $ShimContent = "@echo off`r`n`"$TargetCli`" %*`r`n"
    [IO.File]::WriteAllText($ShimPath, $ShimContent, (New-Object Text.UTF8Encoding $false))

    Copy-Item (Join-Path $Root "LICENSE") (Join-Path $DocDir "LICENSE") -Force
    Copy-Item (Join-Path $Root "LICENSES\Bun-1.4.0.md") (Join-Path $DocDir "Bun-1.4.0.md") -Force
    Copy-Item (Join-Path $TargetDir "THIRD_PARTY_NOTICES.txt") (Join-Path $DocDir "THIRD_PARTY_NOTICES.txt") -Force

    if ($HadPrevious) { Remove-Item $BackupDir -Recurse -Force }
  } finally {
    if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
  }

  Write-Host "Installed $TargetDir (from local checkout, version $Version)"
  if (($env:Path -split ";") -notcontains $BinDir) {
    Write-Host "Note: $BinDir is not on PATH. Add it, e.g.:"
    Write-Host "  [Environment]::SetEnvironmentVariable('Path', `"`$env:Path;$BinDir`", 'User')"
  }
  if ($SetupArgs.Count -gt 0) {
    & $ShimPath setup @SetupArgs
    exit 0
  }
  # Terminal-only "setup --browser-only" requires macOS (src/setup.ts); on Windows the launcher
  # drives setup itself (it supplies --browser-host-descriptor), so point there instead.
  Write-Host "Next: install/run the Codex Web GPT launcher (./scripts/install-launcher-local.ps1),"
  Write-Host "then use its Settings -> Local exec (HITL) to finish setup and run 'serve --hitl'."
} finally {
  Pop-Location
}
