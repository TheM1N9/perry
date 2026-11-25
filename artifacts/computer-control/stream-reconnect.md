# Native stream reconnect acceptance

`stream-reconnect.mjs` closes the exact awaited-pointer-release gap in the broader computer-control acceptance. Read `stream-reconnect-failure-cases.md` before changing it.

The fixture starts installed Chrome with an empty native Temp profile and a loopback page. Actual HTTP NDJSON viewers consume the production `streamBrowser`; owner control uses the production browser controller. When the last viewer disconnects with a pointer held, Chrome receives and answers its real `mouseReleased` command. The fixture holds only delivery of that authentic acknowledgement to the awaiting cleanup, rejoins the same cast, then releases it. A real page click and fresh native frames prove the rejoined viewer remains usable.

```powershell
$env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp'
$env:TMP = $env:TEMP
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/computer-control/stream-reconnect.mjs node_modules/.cache/stream-reconnect-native
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/computer-control/stream-reconnect.mjs node_modules/.cache/stream-reconnect-baseline --baseline
```

Verified on Windows with **Chrome 158.0.8127.37**, native CDP protocol 1.3. Current source passes all **9 checks**. The child-only baseline replaces exactly the post-release watcher recheck with its former unconditional deletion and fails the three race/leak invariants. It deliberately exits nonzero; no product source is edited by that comparison.

| Observation | Current source | Guard-disabled baseline |
| --- | --- | --- |
| New viewer retains original registered cast after release | Pass | Cast deleted |
| Native screencasts started/stopped | 2 / 2 | 2 / 1 |
| CDP listeners before/after final disconnect | 1 / 1 | 1 / 2 |
| Retained views and leases after final disconnect | 0 / 0 | 0 / 0 |
| Rejoined real input and native frames | Pass | Pass, but orphaned |
| Already-aborted viewer adds resources | None | None |
| Pending native CDP commands after viewer teardown | 0 | 0 |

Both modes close all HTTP viewers, exit the Chrome child and remove the native Temp home, including the failing baseline. Results are `result.json` in the selected output directories. The fixture bypasses Next routing/authentication, which the broader browser acceptance covers separately; it uses real HTTP streaming, production stream lifecycle and native browser/CDP, and needs no shared build. It establishes this interleaving, not a sustained browser soak or cross-platform Chrome compatibility.

A single contained PowerShell cleanup of the two new output directories was rejected by automatic review as “blocked by policy.” No retry or alternate deletion mechanism was attempted. The small JSON outputs remain alongside this repeatable acceptance record; all native browser/profile/HTTP resources were cleaned up by the fixture itself.
