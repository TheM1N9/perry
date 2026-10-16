# Batch 3 acceptance

Development branch: `codex/batch-3-chat-quality`, base `0d380a353e5ded68cb450d7904f6bb0a2ddb44ea` (merged PR298). No installed Perry update, main merge or deployment.

Implemented #240 reader-controlled scrolling/native anchors, #241 conservative streaming Markdown, #237 bounded recent-history reuse, #257 silence/recording safeguards and DOM FFT bars, #258 explicit stale-tab refresh notice. Review corrected a same-key prefetch/session race, cleared all chat payload families at secret/session boundaries, removed the final obsolete voice meter consumer, and made the build identity survive Next compiler-worker config reloads.

## Executed

- Codegen: 96 modules, generated files unchanged. Full root TypeScript and separate Convex TypeScript: exit 0. One production profiling build: exit 0, all routes generated; `build-output.txt`. Two pre-existing dynamic-filesystem tracing warnings refer to unchanged `convex/pet.ts` and `server/wake.ts`. Native BUILD_ID appears in browser and server bundles: `build-identity.json`.
- Actual BackendClient with intercepted fetch: 10 flows, 90 calls, max one outstanding prefetch. TTL, count/serialized byte caps; route/key/session isolation; late invalidation; four chat payload families cleared on secrets/session change. `237/`.
- Installed ReactMarkdown/GFM SSR: 16 repair +18 unchanged/static fixtures, 61 table/fence prefixes, bounded/independent tail repair. Static disabled output identical. `241/`.
- Actual voice hook compiled into fake React/media lifecycle VM: 20 grouped scenarios, including cancellation/open/decode/bridge races, silence, malformed PCM, cap and resource release. `257/`. This harness is not native media/React acceptance.
- Actual production dashboard and `/pet` via Codex in-app browser, fresh synthetic SQLite and fake media/bridge: `browser-evidence.json`, `review-ui.jpg`. Reader top remained 5888 through streamed growth/replacement; a tool detail expanded without subsequent layout moving the reader; prepend preserved the first visible row offset 84; explicit New reply below reached the bottom. Partial bold, GFM table and open JS fence rendered in the DOM. Cached distinct history was present while fresh metadata held Composer back; previous-chat text was absent.
- With 200 saved messages, typing and streaming recorded zero historical MessageRow renders. Positive control navigation mounted 20 MessageRows. Stream phase includes one structural ChatScreen update plus live clock ticks, not a claim of zero screen updates for metadata/health changes.
- Real Pet React controls with synthetic hardware: silence made no transcription call; deadline advanced only the captured five-minute timer, released tracks/contexts/recorder timers and inserted the synthetic transcript into the draft; cancelled held transcription did not append its late response. Actual 28 DOM FFT bars changed transforms. The quiet voice profiling sample has no counted renders, but its immediate cancellation positive-control sample was stale; do not treat that voice render counter as independently calibrated proof. The separate lifecycle harness/source inspection establish no meter-driven React state.
- Synthetic version mismatch + actual SSE disconnect/reconnect showed the notice without changing draft text; rollback/equal and missing identity removed it; repeated same status after dismissal did not reopen it. Explicit Refresh reloaded the page and cleared the in-memory synthetic draft. The fixture intentionally serves one compiled build while varying raw backend identity, so it does not simulate downloading a second deployed build.
- Prior integrated regression harnesses rerun against this checkout: queue admission/removal (12 checks), connection refresh (14), Notes mixed-event invalidation (five groups, 2 decoded ordinary rows of 240 Brain rows), stream lifecycle/redaction/Telegram ordering (20k characters, 31,740 delta payload bytes, zero metadata reruns during growth). Expected synthetic Telegram failure/timeout messages are part of lifecycle fault injection. `regressions.json`.

The initial fake SSE proxy failed to close its downstream response; that reconnect attempt is inconclusive. Fixture was corrected and only the disposable server restarted. Final `versionReconnect`, `dismissStable`, `missingVersion`, `explicitRefresh` entries supersede it. Some raw early observations precede asynchronous DOM/panel settlement. `reader.jump` searched the wrong button label; `boldAndVersion.buttons` records the actual New reply below control. The copy-code button was exercised, but in-app clipboard returned empty: OS clipboard behavior is unverified, not a pass.

## Repeat

Use installed dependencies only, repo cwd, pnpm, and fresh W: scratch. Read failure inventories first. No engine/API/bootstrap or real audio/account is needed.

```powershell
pnpm exec node --experimental-strip-types scripts/codegen.ts
pnpm exec tsc --noEmit --incremental false
pnpm exec tsc --project convex/tsconfig.json --noEmit --incremental false
pnpm exec node --import ./artifacts/batch-3/237/loader.mjs artifacts/batch-3/237/client-e2e.mjs
pnpm exec node --experimental-strip-types artifacts/batch-3/241/render-check.mjs
pnpm exec node artifacts/batch-3/257/e2e.mjs
powershell -NoProfile -File artifacts/batch-3/run-isolated.ps1 Build
powershell -NoProfile -File artifacts/batch-3/run-isolated.ps1 UI
```

Build wrapper strips application environment and excludes dotenv. UI preload requires explicit opt-in and a fresh `.batch-work/batch-3/coordinator/ui/run-*` home, supplies a stopped Runtime singleton before Next startup, blocks child processes and remote fetch, and injects instrumentation only into synthetic HTML. Never use plain next start or point these fixtures at real data. Proxy 17484 / Next 17483 are loopback only. The fresh `fixture.json` supplies the chat URL. `/__batch/stream` accepts the small JSON fixtures; `/__batch/version/{same,different,missing}`, `/__batch/reconnect`, `/__batch/delay/0..3000` are disposable-only controls. Use actual UI actions for browser acceptance; resource counters are in the synthetic media panel.

## Limits and cleanup

No real microphone/device/codec/Electron, real upgrade/service restart, OS clipboard, or live engine/account test. Browser timer suspension can delay deadline handling; PCM handed to transcription is independently capped at five minutes. Silence gating is an amplitude heuristic, not speech recognition. Recent-history budget accounts serialized UTF-16 bytes plus allowance, not measured heap. Explicit Refresh intentionally discards an unfinished in-memory draft; the notice tells the owner to finish it first. Already-open pre-feature tabs need one manual reload to gain this feature.

The disposable server was stopped through its own execution session; its verified PID is absent and browser tabs are closed. Automatic approval review rejected both the combined cleanup and the narrower deletion of the two fresh UI homes, returning only "blocked by policy". Deletion was not rerouted through another interpreter. Two UI homes and a compile cache remain on W: (13,165,034 bytes total); exact paths/sizes are in `retained-scratch.json`. The rerun regression homes listed there are empty. No previous broad C: cleanup is repeated; installed Perry, real profiles/data, services and cached dependency junctions remain untouched. At final check C: had 37,229,748,224 bytes free; W: had 81,096,069,120 bytes free.

