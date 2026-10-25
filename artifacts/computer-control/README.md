# Computer-control audit

Four reproduced browser-control bugs:

1. A browser call already waiting for approval could execute after chat Stop.
   MCP cancellation covered internet reads only. Browser calls now observe
   turn cancellation, request abort, Stop and global Pause, including while
   waiting for approval, CDP responses and navigation. Interrupted approval
   requests expire and cannot be approved later. Cancellation stops loading
   only in the affected chat while preserving another chat and owner takeover.
2. A fresh page snapshot could reassign element numbers while returning the
   same identity. An old ref could click a different button. Each observation
   now advances the revision; navigation during observation rejects the result.
3. Manual ArrowLeft, Delete and Ctrl+A did not perform their editing actions.
   The panel now forwards the physical event's numeric key code through the
   validated protocol to Chromium's `windowsVirtualKeyCode` parameter.
4. Manual typing queued before a tab switch selected its destination when the
   queue drained, putting text in the new tab. Queued keys and coalesced scrolls
   now retain their original identity and are dropped when that page changes.
   Closing the panel aborts pending control requests and invalidates its state.

Load-wait listeners and timers now tear down on normal completion and abort;
pending CDP commands remove their abort listeners and timeouts when settled.

## Reproduce

From the repo root with installed dependencies and Node 25:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/computer-control/run.ts
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/parallel-sessions/run.ts
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/tool-approval-routing/e2e.ts node_modules/.cache/perry-computer-approval-regression
pnpm exec tsc --noEmit --incremental false -p convex/tsconfig.json
pnpm exec powershell -NoProfile -File artifacts/batch-1/run-isolated.ps1 -Mode Build
```

Set `PERRY_BROWSER_PATH` to an installed Chromium executable on another machine.
The Windows default uses installed Chrome with a fresh, disposable profile under
`node_modules/.cache/perry-computer-control`. No personal profile is opened.

The harness uses real Runtime/SQLite handlers, real MCP HTTP dispatch, actual
approval/Stop/Pause mutations, a real Chromium process, and a loopback web page.
For the queued-input journey it replays the production panel's `manual` function
against the real browser host. It does not mount the entire React dashboard.
External Node fetches are blocked; the scheduler stays stopped and no native
model, account or service runs. Browser processes close after every run; fixture
profiles remain under the ignored cache for inspection.

`baseline.json` records five initial failing checks. `queued-input-baseline.json`
records the additional queued-input failure after the first fixes. `result.json`
records 19 passing checks, with browser version and observed page values.
`verification.json` records final validation and source hashes. The original
failure inventory also lists launch/restart, retained browser-state maps and
downloads, and desktop/native-app paths; those are not covered by these journeys.

Protocol reference reviewed:
[CDP Input.dispatchKeyEvent](https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent).
