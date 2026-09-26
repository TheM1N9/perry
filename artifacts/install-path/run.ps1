# powershell -NoProfile -ExecutionPolicy Bypass -File artifacts/install-path/run.ps1 <outDir>
# The installer, run as `iwr ... | iex` runs it: in this PowerShell session, whose PATH predates the install.
# It re-runs on the existing ~\perry with PERRY_NO_SETUP=1 (safe to run again: it pulls, installs, relinks).
# Ways it could fail:
#   1. perry is not found in this window afterwards.
#   2. This window's PATH is reordered or loses entries.
#   3. The console's output encoding is not put back.
#   4. The script does not parse in Windows PowerShell 5.1.
param([string]$OutDir = (Join-Path $PSScriptRoot '.'))
$ErrorActionPreference = 'Continue'
$bin = Join-Path $HOME '.perry\bin'
# A window opened before the install: no ~\.perry\bin on its PATH.
$env:Path = (($env:Path -split ';') | Where-Object { $_ -and ($_.TrimEnd('\') -ne $bin) }) -join ';'
$before = @($env:Path -split ';' | Where-Object { $_ })
$hadPerry = [bool](Get-Command perry -ErrorAction SilentlyContinue)
$encodingBefore = [Console]::OutputEncoding.WebName
$script = Get-Content -Raw (Join-Path $PSScriptRoot '..\..\install.ps1')
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$null, [ref]$parseErrors)
$env:PERRY_NO_SETUP = '1'
$output = Invoke-Expression $script *>&1 | Out-String
$after = @($env:Path -split ';' | Where-Object { $_ })
$perry = Get-Command perry -ErrorAction SilentlyContinue
$checks = [ordered]@{
  parses = ($parseErrors.Count -eq 0)
  perryMissingBefore = (-not $hadPerry)
  perryFoundAfter = [bool]$perry
  perryIsTheLauncher = ($perry -and $perry.Source -like "$bin*")
  pathKeptInOrder = (($after[0..($before.Count - 1)] -join ';') -eq ($before -join ';'))
  encodingRestored = ([Console]::OutputEncoding.WebName -eq $encodingBefore)
  installedMessage = ($output -match 'Installed\.')
}
$result = [ordered]@{ ranAt = (Get-Date).ToString('o'); checks = $checks; perry = $perry.Source; encoding = $encodingBefore; added = @($after | Select-Object -Skip $before.Count); passed = -not ($checks.Values -contains $false) }
$result | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 (Join-Path $OutDir 'result.json')
$output | Out-File -Encoding utf8 (Join-Path $OutDir 'installer-output.txt')
$result | ConvertTo-Json -Depth 4
