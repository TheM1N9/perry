# Perry installer for Windows.
#
#   iwr -useb https://raw.githubusercontent.com/TheM1N9/perry/main/install.ps1 | iex
#
# Uses the Git, Node.js, pnpm, Bun and Codex CLI you already have, wherever
# they are installed, and installs only what is missing. A Node older than
# Perry needs is not upgraded behind your back: it says so and stops. Then it
# gets Perry into ~\perry, installs its packages, and runs
# `perry setup`, which sets up a Telegram bot if you want one and signs in to Codex,
# keeps your data in ~\.perry, starts Perry in the background and opens the
# dashboard. Safe to run again: it updates what is there.
#
# PERRY_DIR, PERRY_REPO and PERRY_BRANCH change where it goes and what it
# fetches. PERRY_NO_SETUP=1 stops after installing, with the perry command linked.

& {
  $ErrorActionPreference = 'Stop'
  $repo = if ($env:PERRY_REPO) { $env:PERRY_REPO } else { 'https://github.com/TheM1N9/perry.git' }
  $branch = if ($env:PERRY_BRANCH) { $env:PERRY_BRANCH } else { 'main' }
  $dir = if ($env:PERRY_DIR) { $env:PERRY_DIR } else { Join-Path $HOME 'perry' }

  # One line per step that went well; a tool's own output only when it fails.
  function Ok($text) { Write-Host "  $text" -ForegroundColor Green }
  $tools = [System.Collections.Generic.List[string]]::new()
  function Found($text) { $tools.Add($text) }
  function Added($text) { $tools.Add("$text (new)") }
  function Has($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
  # Runs a step with its output held back, shown only if it fails. Stderr is output here, not an error:
  # git and npm write their progress there.
  function Quietly($what, [scriptblock]$work) {
    $ErrorActionPreference = 'Continue'
    Write-Host "  $what..." -NoNewline -ForegroundColor DarkGray
    $out = & $work 2>&1 | ForEach-Object { "$_" } | Out-String
    $code = $LASTEXITCODE
    Write-Host "`r$(' ' * ($what.Length + 5))`r" -NoNewline
    if ($code -ne 0) { Write-Host $out.Trim() -ForegroundColor DarkGray; throw "$what failed (exit $code)." }
  }
  # This session's PATH, then the saved ones (a tool installed a moment ago, or since this window opened), then
  # where tools you already have usually live: nvm-windows, Volta, Scoop, npm's global folder, Bun and winget.
  # Appended in that order, so a tool already on your PATH always wins.
  # iex runs this in your own PowerShell window, so its PATH is only ever added to, never reordered or trimmed.
  function Refresh-Path {
    $path = @($env:Path -split ';' | Where-Object { $_ })
    $seen = @{}
    foreach ($dir in $path) { $seen[$dir.TrimEnd('\').ToLower()] = $true }
    $candidates = @(([Environment]::GetEnvironmentVariable('Path', 'Machine')) -split ';') + @(([Environment]::GetEnvironmentVariable('Path', 'User')) -split ';') + @(
      $env:NVM_SYMLINK, (Join-Path $env:LOCALAPPDATA 'Volta\bin'), (Join-Path $HOME 'scoop\shims'), (Join-Path $env:APPDATA 'npm'),
      (Join-Path $HOME '.bun\bin'), (Join-Path $env:LOCALAPPDATA 'pnpm'), (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'),
      (Join-Path $env:ProgramFiles 'nodejs'), (Join-Path $env:ProgramFiles 'Git\cmd'))
    foreach ($dir in $candidates) {
      if (-not $dir) { continue }
      $key = $dir.TrimEnd('\').ToLower()
      if ($seen[$key] -or -not (Test-Path -LiteralPath $dir)) { continue }
      $path += $dir
      $seen[$key] = $true
    }
    $env:Path = $path -join ';'
  }
  function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)." } }
  function Winget($id, $what) {
    if (-not (Has winget)) { throw "$what is not installed, and winget is not here to install it. Install $what, then run this again." }
    Quietly "installing $what" { winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements --silent }
    Refresh-Path
  }
  function NodeVersionOk {
    if (-not (Has node)) { return $false }
    $v = (node -p "process.versions.node") -split '\.'
    return ([int]$v[0] -gt 22) -or ([int]$v[0] -eq 22 -and [int]$v[1] -ge 13)
  }

  # Windows PowerShell reads what pnpm, Bun and Codex print in the old console code page, which garbles
  # their box drawing and symbols. UTF-8 while this runs; your window's own setting comes back after.
  $encoding = [Console]::OutputEncoding
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  try {
    Write-Host "`nInstalling Perry" -ForegroundColor White
    Refresh-Path
    if (Has git) { Found "git $((git --version) -replace 'git version ', '')" }
    else { Winget 'Git.Git' 'Git'; Added "git $((git --version) -replace 'git version ', '')" }
    if (NodeVersionOk) { Found "node $(node --version)" }
    elseif (Has node) {
      # Your Node is yours: Perry does not upgrade it behind your back.
      throw "Perry needs Node.js 22.13 or newer, and this machine has $(node --version). Update it (winget upgrade OpenJS.NodeJS.LTS, or your version manager), then run this again."
    } else {
      Winget 'OpenJS.NodeJS.LTS' 'Node.js'
      if (-not (NodeVersionOk)) { throw 'Node.js did not install. Install Node.js 20.9 or newer, then run this again.' }
      Added "node $(node --version)"
    }
    if (Has pnpm) { Found "pnpm $(pnpm --version)" }
    else { Quietly 'installing pnpm' { npm install -g pnpm@10 }; Refresh-Path; Added "pnpm $(pnpm --version)" }
    if (Has bun) { Found "bun $(bun --version)" }
    else { Quietly 'installing Bun' { powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex" }; Refresh-Path; Added "bun $(bun --version)" }
    if (Has codex) { Found 'codex' }
    else { Quietly 'installing the Codex CLI' { npm install -g @openai/codex }; Refresh-Path; Added 'codex' }
    Ok ($tools -join ', ')

    if (Test-Path (Join-Path $dir '.git')) {
      Quietly 'updating Perry' { git -C $dir pull --ff-only }
    } elseif ((Test-Path $dir) -and (Get-ChildItem -Force $dir | Select-Object -First 1)) {
      throw "$dir exists and is not a Perry checkout. Move it, or set PERRY_DIR to another folder."
    } else {
      Quietly 'downloading Perry' { git clone --branch $branch $repo $dir }
    }
    Push-Location $dir
    try {
      Quietly 'installing packages' { pnpm install --frozen-lockfile }
      Ok "Perry in $dir"
      if ($env:PERRY_NO_SETUP -eq '1') {
        bun --cwd $dir (Join-Path $dir 'scripts\perry.ts') link; Check 'Linking perry'
        # Linking saved ~\.perry\bin to your PATH; this window gets it too, so perry works here now.
        Refresh-Path
        Write-Host "`n  Installed. Run 'perry setup' to finish." -ForegroundColor Green
      } else {
        bun --cwd $dir (Join-Path $dir 'scripts\perry.ts') setup; Check 'perry setup'
        Refresh-Path
      }
    } finally { Pop-Location }
  } catch {
    Write-Host "`n  $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '  Fix that, then run the installer again; it picks up where it stopped.' -ForegroundColor DarkGray
  } finally {
    [Console]::OutputEncoding = $encoding
  }
}
