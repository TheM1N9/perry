# Owner-visible background-task relay

`run.ts` uses the production server, real runner, actual MCP tools, real Chrome and a loopback Telegram stand-in. Grok's ACP protocol is played by the existing fake agent. Empty account homes, disabled OpenCode discovery, a seeded fixture embedder and a loopback-only fetch guard prevent live provider calls and model downloads. The fixture refuses to continue if another engine is signed in. Read `failure-cases.md` before extending isolation.

Run after a coordinated `pnpm build` and hold that build until this fixture exits:

```powershell
$env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp'
$env:TMP = $env:TEMP
$env:PERRY_E2E_DIR = $env:TEMP
pnpm exec bun artifacts/task-handoff/run.ts node_modules/.cache/task-handoff-native-final
```

Chrome sends task requests and owner answers through the current contenteditable composer. Primary rendered replies are read separately from the task cards in work history: a snoozed task correctly retains its unanswered question in its card, while its obsolete unadmitted relay must never ask it again. The fake agent's `REBLOCK <question>` owner answer produces a real second task turn/MCP question through the supported parent-chat resume flow; child task pages intentionally have no composer.

The preload can briefly defer relay dispatch through the native scheduler while both child outcomes become ready. It invokes the unchanged real handler after release and rejects fixture-gate timeouts. A separate bounded preparation gate exercises cancellation before the native engine starts. The fixture also stops/restarts its actual server and runner with the same SQLite home while a durable relay is pending; the browser reconnects and receives the original result once.

Before the product fix, the cross-channel baseline displayed `OBSOLETE-RELAY-QUESTION` beside the completed phone-answer result. Its immutable blocked report and current done report both shared one delivered parent run. The product now records a blocked receipt's decision generation and marks an obsolete unadmitted report `superseded`, preserving its history without claiming delivery. Recovery selects only pending/waiting receipts. Already-admitted text is outside this withdrawal guarantee.

The expanded acceptance covers owner-visible completion; hidden/outside provenance; full long results and transcript/run isolation; no duplicate completion; blocked/resume in the same task; deterministic sibling batching; dependencies; queued/preparing/running cancellation; crash/restart; Telegram origin; cross-channel completion; changed wording and unchanged wording with a new snooze generation; superseded recovery; engine-limit relay deferral; and browser/runtime cleanup.

Final validation passed **50/50** on coordinated production build 67830 (`42ad2d3a-99ce-4e99-92f4-ebb8b7579c43`), with no browser runtime errors or fixture dispatch timeouts. `node_modules/.cache/task-handoff-native-final/result.json` records every check, the actual primary browser reply and the separately retained snoozed task card; `owner-visible-relay.png` captures the owner chat. The original stale-question failure is preserved under `task-handoff-native-stale`.

The runner/browser/server closed and the final native Temp home was removed. The corrected fixture uses `turnStreams.getChatStream` for progress and resumes changed questions from the supported parent UI; it does not try to type in intentionally read-only child pages. This proves protocol and lifecycle behavior with stand-ins, not live provider behavior or model judgment quality.

Automatic review blocked one contained PowerShell cleanup of the four new output directories as “blocked by policy.” No retry or alternate deletion route was attempted. The small JSON/PNG outputs remain; all actual native Temp homes and browser profiles were removed by normal teardown.
