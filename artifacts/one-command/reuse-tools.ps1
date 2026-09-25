# powershell -ExecutionPolicy Bypass -File artifacts/one-command/reuse-tools.ps1 <outDir>
# Windows, on a machine that already has Git, Node 20.9+, pnpm, Bun and Codex.
# Runs install.ps1 as `iwr | iex` would (text through iex, in the caller's own
# session) with PERRY_NO_SETUP=1, a throwaway PERRY_DIR and PERRY_HOME, and
# this checkout's branch.
#
# Ways the installer could install what is already there, or disturb it:
#   1. A tool that is here is installed again: every tool must say "already
#      installed", and nothing may say "installing".
#   2. The caller's session PATH is reordered or trimmed (iex runs in their
#      window): the PATH after must start with the PATH before, unchanged.
#   3. An old Node is upgraded behind the owner's back: with a Node 18 first on
#      PATH, the installer must stop and say so, without running winget.
param([string]$OutDir)
# Git and pnpm write progress to stderr, which Windows PowerShell would otherwise treat as a failure.
$ErrorActionPreference = 'Continue'
$repo = (Get-Location).Path
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
$scratch = Join-Path $env:TEMP ("perry-reuse-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $scratch, $OutDir | Out-Null

function Run-Installer($pathPrefix) {
  $script = @"
`$env:PERRY_NO_SETUP = '1'; `$env:PERRY_NO_PATH = '1'; `$env:PERRY_REPO = '$repo'; `$env:PERRY_BRANCH = '$branch'
`$env:PERRY_DIR = '$scratch\perry'; `$env:PERRY_HOME = '$scratch\home'
$(if ($pathPrefix) { "`$env:Path = '$pathPrefix;' + `$env:Path" })
`$before = `$env:Path
iex (Get-Content -Raw -LiteralPath '$repo\install.ps1')
Write-Output "PATH-BEFORE=`$before"
Write-Output "PATH-AFTER=`$env:Path"
"@
  $out = powershell -NoProfile -ExecutionPolicy Bypass -Command $script *>&1 | Out-String
  return $out
}

$checks = [ordered]@{}
try {
  # 1 and 2. Everything already here.
  $present = Run-Installer $null
  $tools = 'git', 'node', 'pnpm', 'bun', 'codex'
  $checks.everyToolFound = -not ($tools | Where-Object { $present -notmatch "(?m)^\s*$_\b.*\(already installed\)" })
  $checks.nothingInstalled = $present -cnotmatch '(?m)^\s+installing ' -and $present -notmatch 'installed for Perry'
  $before = ([regex]::Match($present, '(?m)^PATH-BEFORE=(.*)$')).Groups[1].Value.Trim()
  $after = ([regex]::Match($present, '(?m)^PATH-AFTER=(.*)$')).Groups[1].Value.Trim()
  $checks.sessionPathOnlyExtended = $before -ne '' -and $after.StartsWith($before)
  $checks.installed = Test-Path (Join-Path $scratch 'perry\node_modules\next\package.json')

  # 3. An old Node first on PATH.
  $old = Join-Path $scratch 'old node'
  New-Item -ItemType Directory -Force $old | Out-Null
  Set-Content -LiteralPath (Join-Path $old 'node.cmd') -Encoding ascii -Value "@echo off`r`nif ""%1""==""-p"" (echo 18.20.0) else (echo v18.20.0)"
  $oldRun = Run-Installer $old
  $checks.oldNodeStopsWithAdvice = $oldRun -match 'needs Node\.js 20\.9 or newer, and this machine has v18\.20\.0' -and $oldRun -notmatch 'with winget'
} finally {
  Remove-Item -Recurse -Force -LiteralPath $scratch -ErrorAction SilentlyContinue
}

$result = [ordered]@{ ranAt = (Get-Date).ToUniversalTime().ToString('o'); checks = $checks; passed = -not ($checks.Values -contains $false) }
$result | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $OutDir 'reuse-tools-windows-result.json')
($present -split "`n" | Where-Object { $_ -match 'already installed|installed for Perry|installing' }) -join "`n" | Set-Content -Encoding utf8 (Join-Path $OutDir 'reuse-tools-windows.log')
$result | ConvertTo-Json -Depth 4
if (-not $result.passed) { exit 1 }
