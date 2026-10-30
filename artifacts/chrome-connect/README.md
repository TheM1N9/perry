# Chrome connection verification

Failure cases recorded before implementation and E2E code:

- Missing, stale, malformed or non-loopback DevToolsActivePort; disabled remote
  debugging, rejected Chrome consent, connection timeout and browser exit.
- Copying/decrypting cookies instead of using Chrome's approved live session.
- Exposing unrelated Chrome tabs or attaching a tab from another chat; popups,
  closed tabs, stale identities, duplicate concurrent connection attempts.
- Automatic agent takeover after connect/reconnect, bypassed saved-session
  approval, private screenshots or hostile cookie echoes reaching tool results.
- Disconnect/idle timeout/server shutdown killing the owner's Chrome, changing
  its download settings, leaving file-chooser interception or viewport emulation.
- Remote/guest/wrong-key connections bypassing the local owner gate; a late
  connection or old disconnect corrupting a replacement session.
- UI retaining paragraphs/unsupported choices, hiding the primary Chrome action,
  broken keyboard/mobile controls, lost error/recovery feedback.

Use only a disposable Chrome profile and local test account. Preserve JSON,
signed-in-page screenshot and desktop/mobile UI screenshots. Never access the
owner's cookies or profiles during automated verification. Actual native Chrome
consent is a separate manual installed check.

## Results

Windows / installed Chrome: 25 backend checks, 10 production UI checks and
14 existing live-browser/Firefox regression checks passed. Screenshots cover
desktop, mobile and dark mode. Type checks and the production build passed.
The owner's Chrome native bridge also passed after the owner enabled debugging
and allowed the connection: one blank tab created and removed, no cookie or
page-content reads. Chrome's first rejected handshake prompted clearer retry
guidance; its approval is never automated.

## Repeat on Windows

Run from the repository with Node 22+ and the installed Chrome. No paid model
calls are made. The fake dashboard key and disposable profile paths live in
ignored `results/fixture.json`.

```powershell
pnpm exec node node_modules/.pnpm/esbuild@0.27.0/node_modules/esbuild/bin/esbuild artifacts/chrome-connect/run.ts --bundle --platform=node --format=esm --packages=external --outfile=.next/chrome-connect-e2e.mjs
pnpm exec node .next/chrome-connect-e2e.mjs
pnpm build
$fixture = Get-Content artifacts/chrome-connect/results/fixture.json | ConvertFrom-Json
$env:PERRY_HOME = $fixture.home
$env:PERRY_CHROME_USER_DATA_DIR = $fixture.chrome
$env:DASHBOARD_KEY = $fixture.key
pnpm exec next start -p 7386
```

In a second terminal, run `pnpm exec node artifacts/chrome-connect/ui.mjs`.
Set `PERRY_E2E_PLAYWRIGHT` to an installed Playwright `index.mjs` if the bundled
Codex runtime is unavailable. Each run writes JSON and screenshot artifacts.
Stop the disposable server afterward; use a fresh shell for normal Perry work.

`native.ts` is a separate, manually approved check of the default Chrome bridge.
Bundle it with the same esbuild command, replacing the input and output names,
then run it and accept Chrome's prompt. It opens/removes only a blank test tab.
