# Native browser import verification

Failure cases recorded before implementation and E2E code:

- Personal Chrome still running, profile changed during import, locked database,
  path traversal/reparse point, arbitrary source path, missing or newer schema.
- Remote/guest/foreign-origin/wrong-key request, stale identity, agent control,
  duplicate import, source deletion or mutation, unexpected category imported.
- Cancelled UAC, approval under another Windows account, helper timeout/crash,
  wrong named-pipe client, unsupported App-Bound key format or CNG key failure.
- Credentials in logs/API/model output, plaintext exports or temporary files,
  mismatched cookie domain hash, failed authentication/tag, corrupt password row.
- Destination overwritten before validation, partial categories, rollback failure,
  replacing another chat's profile or retaining old encryption keys incorrectly.
- Host termination between category replacements, interrupted rollback, retained
  backups deleted before recovery, recovery paths escaping the owned profile.
- Bundled browser unavailable, interrupted download, accidental personal Chrome
  attachment, import not surviving restart, password autofill not working.
- Unsupported extension permissions/secure preferences, misleading success,
  inaccessible dialog, lost focus, overflow, excess copy, dark-mode contrast.

Only disposable profiles and fake credentials may be used in automated E2E.
Every run must preserve a JSON report and repeatable screenshots. A real
App-Bound Windows check requires the owner to approve the native UAC prompt.
Never automate that approval or expose the owner's credential values.

## Verified on Windows

The reports in `results/` record 23 core checks, 14 existing browser regression
checks, the compact production UI, history and MV3 extension loading, production
helper scope checks, and administrator-approved App-Bound formats 1 and 3.
Autofill, sign-in persistence, credential echo redaction, corrupt-import
preservation, and automatic recovery of an interrupted replacement passed.
All credentials and source profiles were disposable. The CNG check encrypts a
fake key with the installed Windows Chrome protection key; it reads no personal
cookie or password records. No personal-profile import was performed.

## Repeat

Use Node 22.16+ (SQLite backup API), Windows .NET Framework, and a dedicated
Chrome for Testing executable. Set `PERRY_BROWSER_PATH` to that executable, or
install it in Perry's managed runtime cache first. Compile the fixture helper:

```powershell
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
$helper = Join-Path ([IO.Path]::GetTempPath()) 'PerryBrowserImportFixture.exe'
& $compiler /nologo /target:winexe /define:PERRY_IMPORT_FIXTURE /r:System.Web.Extensions.dll /r:System.Security.dll "/out:$helper" (Join-Path $PWD 'scripts\windows-browser-import.cs')
pnpm dlx tsx artifacts/native-browser-import/run.ts
pnpm dlx tsx artifacts/native-browser-import/helper-security.ts
pnpm dlx tsx artifacts/native-browser-import/categories.ts
pnpm dlx tsx artifacts/native-browser-import/app-bound.ts
$env:PERRY_APP_BOUND_FIXTURE_FLAG = '3'
pnpm dlx tsx artifacts/native-browser-import/app-bound.ts
```

Each App-Bound run requires two manual UAC approvals. Run them without another
server or browser using the fixture destination. The production helper is
compiled without `PERRY_IMPORT_FIXTURE` and rejects disposable source roots.

For UI verification, run the core fixture again, then `pnpm build`. In a separate
PowerShell terminal load only the ignored disposable fixture configuration:

```powershell
$fixture = Get-Content artifacts/native-browser-import/results/fixture.json | ConvertFrom-Json
$env:PERRY_HOME = $fixture.home
$env:PERRY_IMPORT_CHROME_ROOT = $fixture.root
$env:PERRY_IMPORT_HELPER_PATH = $fixture.helper
$env:PERRY_BROWSER_PATH = $fixture.browser
$env:DASHBOARD_KEY = $fixture.key
pnpm exec next start -p 7388
```

Then run `pnpm exec node artifacts/native-browser-import/ui.mjs`. Set
`PERRY_E2E_PLAYWRIGHT` to an installed Playwright `index.mjs` if the bundled Codex
runtime is unavailable. Screenshots cover light, dark, mobile, and completion.

## Supported scope

Perry downloads and maintains its own Chrome for Testing engine and uses a
separate profile per chat. Native import is local-owner-only on Windows and
requires an explicit category selection and replacement consent. Protected
Chrome records additionally require the Windows administrator prompt. The
browser remains private and paused afterward, and source profiles are read-only.
Unsupported encryption formats fail before replacement. An interrupted commit
keeps encrypted backups and a bounded recovery journal for the next browser start.

Extensions are opt-in and limited to compatible Manifest V3 extensions whose
public key preserves their original ID. Extension storage, browser sync, saved
cards, passkeys, and enterprise-controlled data are not migrated. Mac/Linux keep
the dedicated browser and manual sign-in; native Windows import is not offered.
