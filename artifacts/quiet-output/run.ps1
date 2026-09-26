# powershell -NoProfile -ExecutionPolicy Bypass -File artifacts/quiet-output/run.ps1 [outDir]
# How much installing Perry says. The installer, as `iwr ... | iex` runs it, twice: a fresh install into a
# throwaway PERRY_DIR (with a space in it) and PERRY_HOME, cloned from this checkout's branch, then again,
# which updates. PERRY_NO_SETUP=1 and PERRY_NO_PATH=1, so it neither sets Perry up nor touches the user's
# PATH. Then setup.ts in a folder of its own (Enter skips the bot), and `perry status`, which only reads.
# perry start, stop and update are not run: the "Perry runner" task they drive is this computer's real one.
#
# Ways it could fail:
#   1. A good install still prints the tools' own output: git's clone progress, pnpm's progress and summary.
#   2. It says more than a line per step: the tools, where Perry went, and that it is installed.
#   3. A failure is hidden along with the noise: a step that fails must still show its output.
#   4. Running it again (the update path) is noisier than the first run.
#   5. setup still numbers its steps or explains itself, or does not save .env.local.
param([string]$OutDir = $PSScriptRoot)
$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$temp = Join-Path $env:TEMP ('perry-quiet-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory $temp | Out-Null
$saved = @{}
foreach ($name in 'PERRY_DIR', 'PERRY_REPO', 'PERRY_BRANCH', 'PERRY_HOME', 'PERRY_NO_SETUP', 'PERRY_NO_PATH') { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }
$pathBefore = $env:Path
$env:PERRY_DIR = Join-Path $temp 'perry checkout'
$env:PERRY_REPO = $repo
$env:PERRY_BRANCH = (git -C $repo rev-parse --abbrev-ref HEAD)
$env:PERRY_HOME = Join-Path $temp 'home'
$env:PERRY_NO_SETUP = '1'
$env:PERRY_NO_PATH = '1'
# What a terminal would show: colors dropped, and a line a carriage return went back over replaced by what
# followed. Captured, each Write-Host -NoNewline is a record of its own, so Quietly's "step..." and the
# spaces that blank it arrive as two lines; on screen they are one line, erased.
$esc = [char]27
$strip = { param($text)
  $text = $text -replace "$esc\[[0-9;]*[A-Za-z]", ''
  $text = $text -replace "(?m)^  [^`r`n]*\.\.\.`r?`n *`r`r?`n", ''
  $text -replace "[^`n]*`r(?!`n)", ''
}
# A native command's stderr, as its text rather than PowerShell's error records around it.
$native = { param([scriptblock]$command) & $command 2>&1 | ForEach-Object { "$_" } | Out-String }
$lines = { param($text) @(($text -split "`n") | Where-Object { $_.Trim() }) }
$noise = 'Cloning into|Progress: resolved|Packages: \+|Lockfile is up to date|dependencies:|Done in|Already up to date|Receiving objects'

try {
  $script = Get-Content -Raw (Join-Path $repo 'install.ps1')
  $first = & $strip (Invoke-Expression $script *>&1 | Out-String)
  $env:Path = $pathBefore
  $second = & $strip (Invoke-Expression $script *>&1 | Out-String)
  $env:Path = $pathBefore

  # 3: a step that fails, through the installer's own Quietly.
  $quietly = [regex]::Match($script, '(?ms)^  function Quietly.*?^  }').Value
  $failed = & {
    $ErrorActionPreference = 'Stop'
    Invoke-Expression $quietly
    try { Quietly 'a step that fails' { git -C $repo rev-parse --verify no-such-ref-for-this-check }; 'not thrown' } catch { "thrown: $($_.Exception.Message)" }
  } *>&1 | Out-String
  $failed = & $strip $failed

  Push-Location $temp
  $setup = & $strip (& $native { '' | bun (Join-Path $repo 'scripts\setup.ts') --from-perry })
  Pop-Location
  $envFile = Join-Path $temp '.env.local'
  # This computer's own Perry, as it is: its real PERRY_HOME.
  $env:PERRY_HOME = $saved['PERRY_HOME']
  $status = & $strip (& $native { bun (Join-Path $repo 'scripts\perry.ts') status })

  $checks = [ordered]@{
    installed = ($first -match 'Installed\.') -and (Test-Path (Join-Path $env:PERRY_DIR 'node_modules'))
    noToolOutputOnFirstRun = -not ($first -match $noise)
    firstRunIsAFewLines = ((& $lines $first).Count -le 5)
    toolsOnOneLine = (@((& $lines $first) | Where-Object { $_ -match 'git .*node .*pnpm .*bun .*codex' }).Count -eq 1)
    failureShowsItsOutput = ($failed -match 'fatal:') -and ($failed -match 'thrown: a step that fails failed')
    secondRunNoNoisier = -not ($second -match $noise) -and ((& $lines $second).Count -le (& $lines $first).Count)
    setupHasNoStepNumbers = -not ($setup -match '\[\d/\d\]|Saving it|Your computer, your bot')
    setupSavedTheKey = (Test-Path $envFile) -and ((Get-Content -Raw $envFile) -match 'DASHBOARD_KEY=')
    setupIsAFewLines = ((& $lines $setup).Count -le 5)
  }
  $result = [ordered]@{ ranAt = (Get-Date).ToString('o'); checks = $checks; passed = -not ($checks.Values -contains $false) }
  $result | ConvertTo-Json -Depth 3 | Out-File -Encoding utf8 (Join-Path $OutDir 'result.json')
  @("# install.ps1, fresh", $first.TrimEnd(), '', "# install.ps1, again", $second.TrimEnd(), '', "# a step that fails", $failed.TrimEnd(), '',
    "# setup.ts (Enter skips the bot)", $setup.TrimEnd(), '', "# perry status", $status.TrimEnd()) -join "`n" |
    Out-File -Encoding utf8 (Join-Path $OutDir 'transcript.txt')
  $result | ConvertTo-Json -Depth 3
} finally {
  $env:Path = $pathBefore
  foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
  Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}
