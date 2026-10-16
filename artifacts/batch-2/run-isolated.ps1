param([Parameter(Mandatory)][ValidateSet('Build', 'UI')][string]$Mode)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Set-Location -LiteralPath $repo
$allowed = @('PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA','HOMEDRIVE','HOMEPATH','SYSTEMDRIVE','OS','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','PSMODULEPATH','TERM')
Get-ChildItem Env: | Where-Object { $_.Name.ToUpperInvariant() -notin $allowed } | ForEach-Object { Remove-Item -LiteralPath ('Env:' + $_.Name) }
$env:NEXT_TELEMETRY_DISABLED = '1'
$env:PERRY_PORT = '17483'
$env:DASHBOARD_KEY = 'batch-ui-synthetic'
$env:PERRY_CREDENTIAL_KEY = '22' * 32
if ($Mode -eq 'Build') {
  $env:PERRY_HOME = Join-Path $repo '.batch-work/batch-2/coordinator/build-home'
  $env:PERRY_DB = Join-Path $env:PERRY_HOME 'fixture.sqlite'
  $env:PERRY_ENGINE = 'batch-fake'
  $env:NODE_OPTIONS = '--import=' + [Uri]::new((Join-Path $repo 'artifacts/batch-1/build-isolation.mjs')).AbsoluteUri
  pnpm exec next build --profile --no-mangling
} else {
  $env:PERRY_BATCH_UI = '1'
  $env:PERRY_HOME = Join-Path $repo ('.batch-work/batch-2/coordinator/ui/run-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs --import ./artifacts/batch-2/ui-server.mjs node_modules/next/dist/bin/next start -p 17483 -H 127.0.0.1
}
exit $LASTEXITCODE
