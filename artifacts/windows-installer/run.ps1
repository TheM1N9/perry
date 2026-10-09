# powershell -NoProfile -ExecutionPolicy Bypass -File artifacts/windows-installer/run.ps1 [outDir]
# The Windows line from the README, typed into Command Prompt and into PowerShell, on a machine left at
# Windows' default execution policy (Restricted), with this checkout's install.ps1 in place of the published one.
# Ways it could fail:
#   1. The shell does not know the command: iwr and irm are PowerShell's, and cmd has neither (the old line).
#   2. Restricted refuses npm's .ps1 shims (pnpm.ps1, npm.ps1), which PowerShell picks before their .cmd.
#   3. Quoting: cmd takes the | for its own pipe, or PowerShell expands a $ before the inner PowerShell sees it.
#   4. PERRY_DIR and PERRY_NO_SETUP do not reach the PowerShell the line starts.
#   5. It says it installed, but nothing is there: no packages, no perry command.
#   6. The Set-Item Env: form, for PERRY_ENGINE and PERRY_PET, does not set the variable in one of the shells.
param([string]$OutDir = $PSScriptRoot)
$ErrorActionPreference = 'Continue'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$published = 'https://raw.githubusercontent.com/TheM1N9/perry/main/install.ps1'
$local = 'file:///' + ((Join-Path $root 'install.ps1') -replace '\\', '/')
# The line as the README shows it, pointed at this checkout's installer.
$readme = Get-Content -Raw (Join-Path $root 'README.md')
$line = ([regex]::Match($readme, '(?m)^powershell -c "irm \S+install\.ps1 \| iex"(?=\r?$)')).Value
$work = Join-Path $env:TEMP "perry-windows-installer-$PID"
New-Item -ItemType Directory -Force $work | Out-Null

# Typed at a prompt: cmd runs it as one command line (grouped, so all of a pipe's output is kept), PowerShell parses it as its own.
function Typed($shell, $text, $name) {
  $out = Join-Path $work "$name.txt"
  if ($shell -eq 'cmd') {
    $p = Start-Process cmd.exe -ArgumentList "/d /s /c `"($text) > `"$out`" 2>&1`"" -Wait -PassThru -WindowStyle Hidden
  } else {
    # Encoded, so the line reaches that PowerShell exactly as typed, quotes and all.
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("& { $text } *> '$out'"))
    $p = Start-Process powershell.exe -ArgumentList "-NoProfile -EncodedCommand $encoded" -Wait -PassThru -WindowStyle Hidden
  }
  [pscustomobject]@{ code = $p.ExitCode; output = (Get-Content -Raw $out -ErrorAction SilentlyContinue) + '' }
}

# Windows' default for a computer nobody has changed; PowerShells started from here inherit it.
$env:PSExecutionPolicyPreference = 'Restricted'
$env:PERRY_NO_SETUP = '1'
$env:PERRY_REPO = "$root"
$env:PERRY_BRANCH = (git -C $root rev-parse --abbrev-ref HEAD)
$env:PERRY_NO_PATH = '1'

$old = Typed cmd "iwr -useb $local | iex" 'old-line-in-cmd'
$installs = [ordered]@{}
foreach ($shell in 'cmd', 'powershell') {
  $env:PERRY_DIR = Join-Path $work "perry-$shell"
  $run = Typed $shell ($line.Replace($published, $local)) "install-in-$shell"
  $installs[$shell] = [ordered]@{
    exit = $run.code
    installedMessage = $run.output -match 'Installed\.'
    noPolicyRefusal = $run.output -notmatch 'cannot be loaded|running scripts is disabled'
    packages = Test-Path (Join-Path $env:PERRY_DIR 'node_modules\next')
    output = $run.output.Trim()
  }
}

# Set-Item Env: before the irm, with a stand-in installer that only says what it was given.
$probe = Join-Path $work 'probe.ps1'
"Write-Output ('engine=' + `$env:PERRY_ENGINE + ' pet=' + `$env:PERRY_PET)" | Out-File -Encoding ascii $probe
$probeUrl = 'file:///' + ($probe -replace '\\', '/')
$env:PERRY_ENGINE = $null; $env:PERRY_PET = $null
$variables = [ordered]@{}
foreach ($shell in 'cmd', 'powershell') {
  $engine = Typed $shell "powershell -c `"Set-Item Env:PERRY_ENGINE claude; irm $probeUrl | iex`"" "engine-in-$shell"
  $pet = Typed $shell "powershell -c `"Set-Item Env:PERRY_PET 'http://192.168.1.20:7377 ABCD-EFGH'; irm $probeUrl | iex`"" "pet-in-$shell"
  $variables[$shell] = [ordered]@{ engine = $engine.output.Trim(); pet = $pet.output.Trim() }
}

$checks = [ordered]@{
  readmeHasTheLine = [bool]$line
  oldLineFailsInCmd = $old.output -match "'iwr' is not recognized"
  installsFromCmd = $installs.cmd.installedMessage -and $installs.cmd.packages
  installsFromPowerShell = $installs.powershell.installedMessage -and $installs.powershell.packages
  restrictedPolicyNotInTheWay = $installs.cmd.noPolicyRefusal -and $installs.powershell.noPolicyRefusal
  engineSetFromCmd = $variables.cmd.engine -eq 'engine=claude pet='
  engineSetFromPowerShell = $variables.powershell.engine -eq 'engine=claude pet='
  petSetFromCmd = $variables.cmd.pet -eq 'engine= pet=http://192.168.1.20:7377 ABCD-EFGH'
  petSetFromPowerShell = $variables.powershell.pet -eq 'engine= pet=http://192.168.1.20:7377 ABCD-EFGH'
}
$result = [ordered]@{
  ranAt = (Get-Date).ToString('o'); line = $line; policy = 'Restricted'; checks = $checks
  oldLineInCmd = $old.output.Trim(); installs = $installs; variables = $variables
  passed = -not ($checks.Values -contains $false)
}
$result | ConvertTo-Json -Depth 4 | Out-File -Encoding utf8 (Join-Path $OutDir 'result.json')
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
$checks | Format-Table -AutoSize | Out-String
"passed: $($result.passed)"
