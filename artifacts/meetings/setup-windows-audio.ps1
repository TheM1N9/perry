$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Virtual audio driver installation is restricted to disposable GitHub-hosted runners.'
}

$work = Join-Path $env:RUNNER_TEMP 'perry-scream'
New-Item -ItemType Directory -Path $work -Force | Out-Null
$archive = Join-Path $work 'Scream4.0.zip'
Invoke-WebRequest -Uri 'https://github.com/duncanthrax/scream/releases/download/4.0/Scream4.0.zip' -OutFile $archive -TimeoutSec 90
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne 'FA33E25F9A46C61E4E0CD83362C51C3D2A45C6FE4091AAD7507E240E40F1A520') {
  throw 'Scream 4.0 checksum mismatch.'
}
Expand-Archive -LiteralPath $archive -DestinationPath $work -Force

# The upstream catalog's certificate expired. Sign its unchanged files for this VM only.
$certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Perry disposable CI audio' -CertStoreLocation 'Cert:\CurrentUser\My' -HashAlgorithm SHA256
$certificateFile = Join-Path $work 'ci-audio.cer'
Export-Certificate -Cert $certificate -FilePath $certificateFile | Out-Null
Import-Certificate -FilePath $certificateFile -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
Import-Certificate -FilePath $certificateFile -CertStoreLocation 'Cert:\LocalMachine\TrustedPublisher' | Out-Null
$signTool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory |
  Sort-Object Name -Descending |
  ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
  Where-Object { Test-Path -LiteralPath $_ } |
  Select-Object -First 1
if (-not $signTool) { throw 'Windows SDK signtool was not found.' }
& $signTool sign /fd SHA256 /s My /sha1 $certificate.Thumbprint (Join-Path $work 'Install\driver\x64\Scream.cat')
if ($LASTEXITCODE -ne 0) { throw 'Could not sign the CI audio catalog.' }

Set-Service -Name AudioEndpointBuilder -StartupType Automatic
Set-Service -Name Audiosrv -StartupType Automatic
Start-Service -Name AudioEndpointBuilder
Start-Service -Name Audiosrv
$driver = Join-Path $work 'Install\driver\x64\Scream.inf'
$install = Start-Process -FilePath (Join-Path $work 'Install\helpers\devcon-x64.exe') -ArgumentList @('install', ('"' + $driver + '"'), '*Scream') -WindowStyle Hidden -PassThru
if (-not $install.WaitForExit(90000)) { $install.Kill(); throw 'Virtual audio driver installation timed out.' }
if ($install.ExitCode -notin @(0, 1)) { throw "Virtual audio driver installation failed: $($install.ExitCode)" }
$devices = @(Get-CimInstance Win32_SoundDevice)
$devices | Select-Object Name, Status, ConfigManagerErrorCode | ConvertTo-Json
if (-not ($devices | Where-Object { $_.Name -match 'Scream' -and $_.ConfigManagerErrorCode -eq 0 })) {
  throw 'The Scream rendering endpoint is not available.'
}
