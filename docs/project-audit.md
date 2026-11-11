# Project audit, updated 11 November 2026

The findings recorded on 10 November below have now been implemented. The follow-up status and verification at the end supersede the original remaining-work list.

UI behavior, product familiarity and predicted visual attention are covered in the [UI and UX audit](ui-ux-audit.md), with an [interactive attention forecast](ui-attention-map.html).

The later [spacing audit](spacing-audit.md) covers 187 current UI/template files, implemented fixes and 448 passing browser assertions. The [spacing rules](design-spacing.md) and [source coverage ledger](spacing-coverage.md) record the system for future work.

Perry should remain a local personal assistant: one owner, one SQLite backend, a same-origin dashboard, and an optional desktop companion. Reliable delivery, recoverable writes and bounded resource use take priority over adding engines or more interface features.

This pass inventoried 477 tracked source, configuration and documentation files outside `artifacts/`, about 86,600 lines before cleanup. It also inspected the existing verification tools and dependency graphs for the root app, site, pet and film. Manual review concentrated on the runtime, storage, authentication, subscriptions, scheduling, messaging, engine lifecycle, desktop integration and UI effects. This is a broad audit with targeted reproductions, not a claim that every line or every supported platform has been exhaustively verified.

## Changes made

| Area | Defect and correction |
| --- | --- |
| Scheduler cancellation | A due-queue snapshot still executed rows cancelled by an earlier scheduled mutation. Mutation execution now checks deletion inside its transaction; actions must successfully claim their row before starting. |
| Scheduler concurrency | Overlapping scans could execute a mutation twice. Queue draining now has one in-flight promise. |
| Scheduler lifecycle | Work could start before `start()`, repeated starts added duplicate cron timers, and `stop()` returned before an active scan finished. Startup is explicit and idempotent; shutdown drains the scan and tracked cron/action work. |
| Query limits | Filtered and full-text `take(0)` returned a document. All query paths now return no rows for zero; negative, fractional and non-finite `take()` limits are rejected. Read dependencies are still recorded for zero-result live queries. |
| Vector index | Deleted vectors left empty slots and retained filter values. Deletion now moves the last live slot into the gap and updates its lookup, keeping cache slots proportional to live vectors. Typed buffers retain their allocated high-water capacity. |
| Event triggers | Shutdown during an awaited query or subscription could recreate resources after cleanup. Lifecycle checks now stop that work, close a late subscription and ignore late events. Folder-watch closure clears its settle timers. |
| WhatsApp | Every reconnect added another abort listener. Each connection now removes its listener and watchdog in `finally`. |
| Analytics | Meeting detail IDs were sent as part of the dashboard route. They now receive the same `:id` replacement as other detail pages. |
| Media HEAD | Ranged HEAD requests opened a file stream and returned bytes. They now return headers with an empty body. |
| Media caches | Successful waveform entries and unfinished playback positions could accumulate across days. Both caches now cap at 100 entries. An old rejected waveform request cannot evict a newer entry for the same source. |
| Dependencies | Updated root Zod and Undici, aligned the site with Next.js 16.4.2 and patched its Sharp/source-map-js resolutions. Updated the pet to Electron 44.9.1 and patched its Sharp and Undici resolutions. No major dependency upgrades were forced. |
| Unused code | Removed ten unreferenced UI wrappers: attachment, badge, button-group, card, empty, hover-card, item, marker, message-scroller and trace. Removed `@shadcn/react`, used only by the unused message-scroller wrapper, plus unused imports and a CLI constant. Existing verification scripts remain. |
| Build tracing | Marked the external Bun/OS process launches as excluded from Turbopack file tracing. Perry runs these programs from its checkout or PATH; tracing the entire repository as their possible executable was unnecessary. |
| Setup guidance | Corrected the documented Node minimum to 22.13, matching the installer and doctor. Removed obsolete Convex-cloud instructions from missing Telegram and Composio key errors. |

## Original follow-up findings, 10 November

1. **High: Telegram can discard an update after ingestion fails.** In [server/telegram.ts](../server/telegram.ts), the polling loop catches `ingest:fromTelegram` errors and then advances the persistent offset. A transient backend failure can permanently skip the message. The offset is also a single `telegram.offset` value, independent of the selected bot. I would add durable per-bot update receipts and acknowledge only accepted updates. Simply replaying the action is insufficient because an action can commit some effects before failing. This pass did not inject Telegram ingestion failures.

2. **Implemented: autosave navigation ordering and recovery.** The [UI/UX implementation](ui-ux-implementation.md) sends unmount saves through the serial drain, captures each edit's destination, keys project/contact editors by identity and keeps failed drafts in session storage until acknowledged. Browser verification delays an earlier request, navigates away after a final edit and checks the persisted result; another case fails the write and recovers its draft on return.

3. **High: upstream dependency work remains.** The root dependency audit still reports 3 high, 7 moderate and 4 low advisories. The high findings are Zod 3 through `shadcn`, `body-parser` through the Claude SDK's MCP/Express dependency, and `systeminformation` through `shadcn`'s dotenv tooling. The film has a Zod 3 finding through `puppeteer-core > chromium-bidi`. The patched Zod version reported by the registry is in major version 4; forcing it into v3 consumers would be unsafe. I would update the owning packages and verify their actual call paths. Site and pet audits currently report no advisories. Advisory counts do not establish whether Perry exposes the vulnerable API.

4. **Medium: local calendar days are treated as 24 hours.** [convex/notify.ts](../convex/notify.ts), `sentToday`, subtracts 86,400,000 from the next local midnight. That is not the start of today across daylight-saving transitions. [convex/todos.ts](../convex/todos.ts) also adds fixed days in `tomorrowsTime`, subtracts them in streak calculation and reads only the preceding 24 hours for today's completed items. I would use the installed cron parser's timezone-aware previous/next calendar boundaries, with transition-day end-to-end cases before changing these related behaviors.

5. **Medium: held notifications bypass fresh quota admission.** [convex/notify.ts](../convex/notify.ts), `releaseHeld`, checks the daily limit once before sending every origin group. A backlog spanning several origins can exceed the remaining daily allowance. It also sends before `markSent`, so a crash between those operations can duplicate delivery. I would put batch admission and durable delivery state behind one mutation; external delivery still needs a defined retry policy.

6. **Medium: closed browser scopes remain in memory.** [convex/lib/browser.ts](../convex/lib/browser.ts) stores every scope in global `__perryBrowsers`. `closeBrowser` closes connections but never removes the scope or clears its download metadata. Over many chats this remains unbounded. I would retire idle scopes only after their active leases and viewers finish, preserving the existing takeover/identity guarantees. The screencast registry already removes entries when its last viewer leaves; it should keep that behavior.

7. **Medium: trigger failure recovery needs another pass.** [server/triggers.ts](../server/triggers.ts) logs watcher errors but can retain a truthy closed watcher in `watchers`, so reconciliation skips replacing it. A rejected `loadDriver()` promise is also retained forever in `driver`. In [server/wake.ts](../server/wake.ts), `timerFor` is set before OS registration succeeds, suppressing a retry for an unchanged target. I would add recovery cases for a deleted/recreated directory, a transient driver failure and a refused wake-timer registration.

8. **Medium: WhatsApp callbacks need a connection generation boundary.** [server/whatsapp.ts](../server/whatsapp.ts) starts QR rendering, pairing-code requests and group discovery without checking that their socket is still current when they finish. An old socket can publish a stale QR/status after a newer one starts. The group-name map also has no eviction or reset on account changes. I would scope callbacks and that cache to the current connection/account, then exercise delayed old-socket completions with the existing fake driver.

9. **Medium: dashboard telemetry and product claims need alignment.** [instrumentation-client.ts](../instrumentation-client.ts) enables PostHog by default in production; [scripts/telemetry.ts](../scripts/telemetry.ts) sends installer milestones unless disabled. The dashboard scrubs content and route IDs, but the README's statement that Perry has no server to send anything to is broader than the implementation. My preference is explicit opt-in dashboard/installer telemetry with a clear setup explanation. That changes an existing product default, so I have recorded it rather than silently changing it. The site's README also describes only Vercel analytics even though [site/instrumentation-client.ts](../site/instrumentation-client.ts) adds PostHog, heatmaps and exception capture.

10. **Medium: installed-library compatibility is inconsistent.** The locked Tiptap React package is 3.31.3 while its optional bubble/floating-menu packages are 3.31.4 and declare exact 3.31.4 core/pm peers. Installation reports the mismatch. Builds pass, but that does not exercise every editor interaction. I would update the Tiptap family together and verify editing, tables, menus and markdown round trips. I would also make required versus deliberately skipped package build scripts explicit; a fresh root install currently warns about skipped scripts including ONNX Runtime and esbuild.

11. **Low: historical verification evidence needs a retention policy.** `artifacts/` contains 1,679 tracked files totalling about 91.5 MB at the initial inventory. Some are CI inputs, fixtures and executable regression checks; many are dated screenshots and result snapshots. Deleting the directory would break CI. I would keep scripts and required fixtures in the repository, move bulky historical evidence to CI/release storage and update references before removing it. Root TypeScript checking currently includes all the historical `.ts` harnesses too.

12. **Partly implemented: marketing interaction leftovers.** The [UI/UX implementation](ui-ux-implementation.md) cleans up Copy timers, resets feedback when the command/OS changes, ignores stale clipboard completions and replaces navigation `transition-all` with color/surface transitions. Film portability remains for review: [film/render.mjs](../film/render.mjs) hardcodes a Windows Chrome installation and does not consistently fail on unsuccessful ffmpeg exits.

13. **Risk to verify: post-commit event failures can obscure successful writes.** In [server/runtime.ts](../server/runtime.ts), `runMutation` calls `committed(tx)` and `onCommit` inside the same `try` that catches transactional errors. If a synchronous change listener throws after COMMIT, the catch attempts ROLLBACK even though the write succeeded. Existing listeners did not trigger this during verification. I would keep database rollback handling separate from post-commit notification failures and add a deliberately throwing-listener replay before editing it.

## Verification

The following completed on Windows with Node 25.8.2, Bun 1.3.8 and pnpm 10.33.0:

| Check | Result and limits |
| --- | --- |
| Root TypeScript and `pnpm exec tsc --noEmit -p convex` | Passed. |
| Root `pnpm build` | Passed after UI cleanup, with no build warnings. |
| `pnpm --dir site typecheck` and `pnpm --dir site build` | Passed with Next.js 16.4.2. |
| `pnpm smoke` | All 9 existing checks passed. Task Scheduler registration was not requested on this workstation. |
| `artifacts/security-audit-20261028/run.mjs` | All 28 checks passed using real HTTP handlers, a loopback adapter and disposable SQLite data. Not a full Next.js deployment test. |
| `artifacts/security-audit-20261028/client-replay.mjs` | All 8 checks passed with the real client and synthetic transport. |
| `artifacts/pr-300/stream-integration.mjs` | All 8 browser-stream checks passed with a synthetic CDP host. |
| `artifacts/pr-300/file-render-integration.mjs` | All 7 file-render checks passed. |
| `artifacts/meetings/run.mjs <output> --backend-only` | All 26 persistence/calendar/speech-transport checks passed. Paid endpoints were replaced by fixtures; no native recording or model inference ran. |
| `artifacts/orphan-tasks/run.mjs` | All 10 checks passed. |
| Disposable defect replay | All 12 scenarios failed against the original implementation and passed after the fixes: scheduler overlap/shutdown/cancellation, query limits, vector churn, trigger shutdown races, WhatsApp listener retention, meeting-route privacy and ranged HEAD responses. |
| Disposable Electron check | Electron 44.9.1 loaded the native hotkey and transformers modules. A hidden sandboxed window used Perry's real preload, received an event and unsubscribed successfully. No hook, microphone, screenshot capture or model inference was started. |
| Code generation and locked installs | Codegen produced no semantic changes. Root, site and pet lockfiles accepted frozen installs. |

The existing Node integration scripts above use the repository's extensionless-import loader. The security, client, meeting and file-render scripts use `--experimental-transform-types --import ./artifacts/security-audit-20261028/loader.mjs`; the orphan-task script uses `--import ./artifacts/secrets-at-rest/node-loader.mjs`. CI contains the exact commands for the remaining scripts.

No macOS/Linux native run, live provider chat, real Telegram/WhatsApp connection, permission prompt, transcription, full film render or multi-day soak test was performed. The media-cache bounds and tracing annotations were reviewed and build-checked; the disposable behavioral replay does not cover those changes. The new isolated failure inventory preceded its replay code. Temporary replay tools, generated evidence and disposable data were removed after verification; existing tracked evidence was restored.

The follow-up implementation below supersedes this original work order.

## Implementation pass, 11 November 2026

### Implemented results

| Finding | Result |
| --- | --- |
| Telegram loss and offset collisions | Per-bot receipts commit with ingestion effects and scheduled work. Offsets advance only after acceptance; acceptance/offset-write failures replay safely. Token changes are checked before each item. Receipts retain two days, beyond Telegram's [24-hour update retention](https://core.telegram.org/bots/api#getupdates). |
| Autosave | Completed in the earlier UI pass: serial navigation saves, destination-scoped drafts and recovery. |
| Dependencies | Updated the Claude SDK and transitive server packages; removed the unused shadcn CLI while preserving its MIT control CSS locally. Updated film Puppeteer. Root, site, pet and film audits now report zero advisories. |
| Local calendar days | Daily quotas, completed-today lists, streaks and postponed reminders now use timezone-aware calendar boundaries from the installed cron parser. |
| Held notifications | Origin/destination batches reserve quota atomically before delivery. Durable states distinguish held, sending, delivered, failed and uncertain attempts. Known failure releases quota; interrupted/ambiguous delivery appears in Needs you without automatic repetition. Grouped review keeps the whole attempted text. WhatsApp completion here means its local outbox/history committed, not handset receipt. |
| Browser retention | Operations and streaming viewers pin scopes. Closed resource-free scopes retire after their last lease/viewer, preserving owner/privacy preferences. Completed download metadata is bounded. Closing during launch rejects and cleans up the late host. |
| Trigger/wake recovery | Recreated folders replace watchers, watcher errors invalidate entries and rejected driver loads retry. Failed wake registration does not cache success. Shutdown checks prevent late resources. |
| WhatsApp lifecycle | Delayed QR/code/group results and incoming callbacks verify their connection. Owned listeners detach on replacement/shutdown. Outgoing work captures its socket/mode; account changes clear bounded identity/group caches. |
| Privacy | Dashboard diagnostics and installer milestones default off. General settings exposes browser-local consent and revocation; installer opt-in is explicit. Site PostHog requires its build flag. README/setup/site copy now describes actual external services. |
| Editor compatibility | Direct Tiptap packages align at 3.33.1. Formatting, tables, slash commands, Markdown persistence and canonical Brain links were verified. Required esbuild/Sharp scripts and intentionally skipped optional ONNX/protobuf scripts are declared. |
| Evidence retention | Removed 98 unused generated `fewer-boxes` screenshots, 10.09 MiB. Seeds, replays and compact results remain; Git retains old images. Future CI evidence expires after 14 days. Historical harnesses have a separate typecheck. |
| Film | Native Chrome discovery or an explicit executable replaces a hardcoded path. ffmpeg failures propagate; audio/frames persist for resumption; matching outputs/stills skip work. Native stream backpressure and cleanup cover encoder, browser and server. |
| Post-commit failures | Rollback handling ends at COMMIT. Subscriber/file-cleanup/completion-callback errors cannot turn a saved write into a failed mutation or starve other subscribers. |
| Latest UI proposals | New-chat guidance sits with the composer; typing preserves the suggestion footprint. Pending approvals have an in-chat Review link, explicit affected paths and collapsed persistent rules. Supervised-access descriptions reflect the sandbox policy. |

### Still needs review or an external environment

- **Other historical bundles.** The initial inventory was 1,679 tracked files / 91.5 MiB. Remaining bundles mix executable inputs, fixtures and evidence. Choose archive storage/retention before moving them; CI imports some of their sources. The verified screenshot removal above preserves those mixed bundles.
- **Native platforms and connected services.** Real Telegram/WhatsApp accounts, macOS/Linux behavior, wake-from-sleep, physical mobile keyboards, screen readers and multi-day operation require those environments. Synthetic transports establish local recovery, not provider delivery guarantees.
- **Attention predictions.** The updated map illustrates alternate landing, scrolling, writing, waiting, approval and returning paths. It remains a design forecast, not measured eye tracking or evidence of comprehension.

Failure inventory before verification code: Telegram acceptance can fail before commit, succeed before an offset write fails, replay an update, switch bots/tokens, or stop mid-batch. Callback side effects must be scheduled atomically with acceptance. A notification batch can race another release, cross quota or midnight, lose its target, fail before sending, time out with an unknown external outcome, succeed before history/bookkeeping fails, or stop mid-flight; an ambiguous send must not automatically duplicate. A post-commit subscriber or file cleanup can throw without changing the successful transaction outcome or starving other subscribers. Calendar logic can cross spring/fall transitions, a non-hour shift, midnight, a missing local time or a historical date. Watchers can close/error while reconciling, directories can disappear/reappear, driver loading can reject and shutdown can interrupt any await. Wake registration can fail with an unchanged target or finish after shutdown. Old WhatsApp connections can complete QR/code/group requests after replacement, account change or shutdown. Browser scopes can close during an agent lease, an owner action, a viewer/stream or an unfinished connection; retirement must not recreate or transfer control. Telemetry must produce no traffic or ledger without explicit consent and must honor disable switches. Dependency/install changes can break native modules, editors, frozen installs or generated output. Film processes can fail to spawn, exit nonzero, close stdin early or fail during cleanup. Historical evidence removal can break CI/imports and must retain executable inputs. New UI changes can hide a draft, misstate an approval consequence, duplicate a review action or obscure recovery at narrow widths.


### Follow-up verification

The failure inventory above preceded the disposable replays. No paid model invocation or real messaging account was used.

| Check | Result |
| --- | --- |
| Runtime/delivery/calendar | 19 assertions passed against real SQLite/functions and loopback Telegram. Covered receipt rollback/retry, duplicate acceptance, post-commit errors, racing quota claims, known refusal, ambiguous transport, send acknowledgement followed by history failure, grouped review, interrupted attempts and DST-day quotas/completions. |
| Real polling loop | 3 scenarios passed: acceptance plus offset-write failure, separate bot offsets and stopping mid-batch. |
| Background lifecycle | 13 assertions passed: unchanged-target wake retry, real folder replacement, failed driver import/retry, subscription shutdown, stale WhatsApp QR/group results, detached listeners, default installer privacy and scope/viewer retirement. OS commands used process fixtures. |
| Real Chromium lifecycle | 4 assertions passed: owner-controlled start, navigation, close/release and Close during launch. Separate temporary profiles were used. |
| Existing integrations | All 28 security, 8 client and 8 stream checks passed. Stream fixtures now model viewer retention and verify last-reader release. |
| Build/dependencies | Product, backend and artifact-harness typechecks passed; production build passed without build warnings; frozen root install accepted. SDK/transformers/native ONNX imports and all 9 smoke checks passed. All four dependency audits report zero advisories. |
| Film | Real-source still rendered then skipped on rerun. Injected nonzero encoder exit retained cache without a completed video. Synthetic one-second render then succeeded and skipped on rerun. Full creative-film rendering was not required. |

The dashboard replay passed 34 assertions covering widths 320/390/768/1024/1440, light/dark and short height; stable composer position, approval anchors/paths/collapsed rules, delivery review, privacy consent/revocation and editor formatting/table/slash/Markdown/Brain-link behavior. Five additional merge checks cover the Riff surface integrated from main: image support with aligned Tiptap, narrow/wide layouts, autosave and Brain redirects. The onboarding replay passed all 25 checks against the merged production build. No microphone capture or provider editing was invoked.

Reports and images were inspected. Existing project tests and historical result records were preserved. Existing CI commands are repeatable; the scenarios above describe the additional failure-injection recipes and their limits.

Cleanup exception: automatic approval review rejected deletion of `.project-fixes/` and the temporary `film/fixes-*` outputs, stills at `0.123`, and their render cache, reporting "blocked by policy." Those task-only files remain locally. The verification server was stopped. The older `fewer-boxes` screenshots were successfully removed earlier; that separate cleanup is complete.
