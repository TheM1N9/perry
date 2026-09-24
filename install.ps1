# Perry installer for Windows.
#
#   iwr -useb https://raw.githubusercontent.com/TheM1N9/perry/main/install.ps1 | iex
#
# Installs what Perry needs that is missing (Git, Node.js, pnpm, Bun and the
# Codex CLI), gets Perry into ~\perry, installs its packages, and runs
# `perry setup`, which sets up your own Convex deployment and Telegram bot,
# connects this computer, starts Perry in the background and opens the
# dashboard. Safe to run again: it updates what is there.
#
# PERRY_DIR, PERRY_REPO and PERRY_BRANCH change where it goes and what it
# fetches. PERRY_NO_SETUP=1 stops after installing, with the perry command linked.

& {
  $ErrorActionPreference = 'Stop'
  $repo = if ($env:PERRY_REPO) { $env:PERRY_REPO } else { 'https://github.com/TheM1N9/perry.git' }
  $branch = if ($env:PERRY_BRANCH) { $env:PERRY_BRANCH } else { 'main' }
  $dir = if ($env:PERRY_DIR) { $env:PERRY_DIR } else { Join-Path $HOME 'perry' }

  function Step($text) { Write-Host "`n$text" -ForegroundColor Cyan }
  function Ok($text) { Write-Host "  $text" -ForegroundColor Green }
  function Has($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
  # A tool installed a moment ago is on the saved PATH, not yet on this session's.
  function Refresh-Path {
    $env:Path = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), (Join-Path $HOME '.bun\bin')) -join ';'
  }
  function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)." } }
  function Winget($id, $what) {
    if (-not (Has winget)) { throw "$what is not installed, and winget is not here to install it. Install $what, then run this again." }
    Write-Host "  installing $what with winget"
    winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements --silent | Out-Host
    Check "Installing $what"
    Refresh-Path
  }
  function NodeVersionOk {
    if (-not (Has node)) { return $false }
    $v = (node -p "process.versions.node") -split '\.'
    return ([int]$v[0] -gt 20) -or ([int]$v[0] -eq 20 -and [int]$v[1] -ge 9)
  }

  try {
    Write-Host "`nInstalling Perry" -ForegroundColor White

    Step 'Tools'
    if (-not (Has git)) { Winget 'Git.Git' 'Git' }
    Ok "git $((git --version) -replace 'git version ', '')"
    if (-not (NodeVersionOk)) { Winget 'OpenJS.NodeJS.LTS' 'Node.js' }
    if (-not (NodeVersionOk)) { throw 'Perry needs Node.js 20.9 or newer. Update Node.js, then run this again.' }
    Ok "node $(node --version)"
    if (-not (Has pnpm)) { Write-Host '  installing pnpm'; npm install -g pnpm@10 | Out-Host; Check 'Installing pnpm'; Refresh-Path }
    Ok "pnpm $(pnpm --version)"
    if (-not (Has bun)) { Write-Host '  installing Bun'; powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex" | Out-Host; Check 'Installing Bun'; Refresh-Path }
    Ok "bun $(bun --version)"
    if (-not (Has codex)) { Write-Host '  installing the Codex CLI'; npm install -g @openai/codex | Out-Host; Check 'Installing Codex'; Refresh-Path }
    Ok 'codex'

    Step "Perry, in $dir"
    if (Test-Path (Join-Path $dir '.git')) {
      git -C $dir pull --ff-only | Out-Host; Check 'Updating Perry'
    } elseif ((Test-Path $dir) -and (Get-ChildItem -Force $dir | Select-Object -First 1)) {
      throw "$dir exists and is not a Perry checkout. Move it, or set PERRY_DIR to another folder."
    } else {
      git clone --branch $branch $repo $dir | Out-Host; Check 'Downloading Perry'
    }
    Push-Location $dir
    try {
      pnpm install --frozen-lockfile | Out-Host; Check 'Installing packages'
      Ok 'packages installed'
      if ($env:PERRY_NO_SETUP -eq '1') {
        bun --cwd $dir (Join-Path $dir 'scripts\perry.ts') link; Check 'Linking perry'
        Write-Host "`n  Installed. Run 'perry setup' in a new terminal to finish." -ForegroundColor Green
      } else {
        bun --cwd $dir (Join-Path $dir 'scripts\perry.ts') setup; Check 'perry setup'
      }
    } finally { Pop-Location }
  } catch {
    Write-Host "`n  $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '  Fix that, then run the installer again; it picks up where it stopped.' -ForegroundColor DarkGray
  }
}
