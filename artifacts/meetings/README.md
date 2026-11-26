# Meeting capture in CI

`pnpm exec node --experimental-transform-types --import ./artifacts/security-audit-20261028/loader.mjs artifacts/meetings/run.mjs <output-directory>`

Requires the root and `pet/` dependencies. No accounts or paid model calls are used. The harness creates its own SQLite database, owner key, native speech fixtures, Electron profile, and backend on an ephemeral loopback port. It deletes its scratch directory and keeps `result.json`, the Electron report, and process logs in the requested output directory.

Calendar checks substitute only Composio's responses, then exercise the production refresh action, SQLite recommendations, dismissal, and dashboard-to-pet handoff. Native checks run the OS microphone probe and drive the sandboxed meeting prompt through pause, dismissal, recording controls and an actual click that starts capture. Each native run saves `meeting-prompt.png` for visual review. On a Mac without microphone permission, call detection reports `permission-blocked` before enumerating devices; it does not wait on a permission dialog. Authenticated calendar permissions and positive detection of a real call still need a connected account and a live meeting.

Native capture defaults to local Whisper Small. Add `--large` to exercise local Whisper Large v3 Turbo, with a longer first-download deadline. The independent microphone and output phrases overlap. Reports include word error rates against the complete known phrases, after normalizing the fixture's currency formatting; each source must stay below 20%. These synthetic phrases establish capture and regression coverage, not accuracy on every accent or language.

Cloud checks substitute Groq's external response and exercise the real authorization, WAV encoding, frozen session settings, error handling, and persistent transcript cache, including empty results. No paid requests run in CI. The UI E2E (`artifacts/meetings/ui.mjs <output-directory>`, after a production build) starts an isolated Perry and headless Chrome, checks the four meeting tabs and transcript search, and saves desktop/mobile screenshots plus `ui.json`. CI uploads these alongside the backend report.

Native cloud runs also inject key, validation, and transient failures at the pet's HTTP boundary to check capture shutdown and queue recovery, including a key failure during Stop. Reports keep native loopback coverage separate from cloud transport coverage. The UI run saves a short-window composer screenshot with a long draft and expanded queue, and checks that a failed write-up keeps personal notes accessible.

The Windows job installs Scream 4.0 on the disposable GitHub-hosted VM to supply a real WASAPI rendering endpoint. A test preload supplies only `getUserMedia` with a synthetic microphone stream from Web Audio. A different recording plays through the Windows output device. Whisper must transcribe both independently through the production capture window, worklet, utility process and backend. `getDisplayMedia`, loopback capture, chunking, IPC and transcription are unchanged. Chromium's global fake-device flags are deliberately avoided because they also replace loopback input.

The macOS job runs the same Electron pipeline. A system-audio permission refusal must be reported clearly while microphone transcription continues. This is recorded as `permission-blocked`, not successful loopback coverage. A live system-audio track that transcribes nothing fails the job. Passing a hosted job cannot establish physical microphone quality, echo cancellation, or macOS permission behavior on every user's machine.

## Failure inventory, before implementing the checks

- The writing deadline passes after render but before passive effects run. The page must still wake once, without polling or repeated expired-deadline wakes. A native React/Chrome consumer of the actual shared hook advances its isolated clock in a layout effect to reproduce that sequence without a query update masking it.
- Deadline selection must handle expired, missing and nonfinite times; select the earliest future deadline and then the next; replace an old deadline; clamp delays beyond the browser timer limit; and clear its pending timer on unmount. The browser probe uses native timers, with timer tracking and an isolated wall-clock offset.
- Completed or failed meeting pages keep a one-second React timer running; active duration stops advancing, a finished duration keeps changing, or leaving the page leaks its elapsed-time clock. The five-minute writing warning disappears, appears early, survives a different meeting, or leaves a deadline scheduled after unmount.
- A writing row with no end timestamp invents a frozen call duration. The warning deadline is tested just before and after five minutes by offsetting only the disposable browser's wall clock; the real timer and production page still run normally. The synthetic server's clock and the owner's Perry stay unchanged.
- A short viewport plus an expanded queue and long draft clips the composer controls, or creates a second page scrollbar. The footer must scroll independently while Send and the permission notice remain reachable.
- Successful write-ups repeat personal notes in Summary; a failed write-up hides personal notes; editing the combined Brain page or regenerating loses the separation.
- Disabling desktop heads-ups stops scheduled calendar refreshes, or refreshing while Perry is paused bypasses the pause.
- Missing/rejected cloud credentials or a closed meeting retry forever; malformed audio blocks later valid chunks; transient failures lose audio instead of retrying. A terminal error must stop capture and retries, retain saved text, and count discarded audio, including the final chunk emitted during Stop.
- A cloud fixture replaces native loopback coverage in the report, hiding permission-blocked coverage or implying a real cloud accuracy check.
- Louder remote speech deletes independent microphone speech; quiet speech or the ends of phrases are cut off; language/model settings are ignored; an accuracy regression passes a keyword-only check.
- Cloud transcription leaks a key to the pet page, runs without opting in, retries a completed paid chunk, accepts another device's meeting, or schedules more requests after disposal. Stop loses queued phrases, or failed requests silently drop speech or silently switch models.
- Switching tabs loses typed notes, hides recording controls, or renders a large transcript while its tab is offscreen. Search/copy actions do not reflect the actual transcript.

- Call prompts fail to appear, steal keyboard focus, render calendar text as HTML, repeat after dismissal, survive pause/recording, or leave their window, timer, and IPC listeners alive after disposal.
- A detected call's prompt never goes away, disappears while the pointer rests on it, or can only be closed with a key it never has focus for. The prompt shows in screen shares.
- The notes stop the moment a call app flickers off the microphone, while people are still talking, or never stop after the call ends; music or video playing afterwards keeps them going; the countdown runs out under the pointer; "Keep going" does not hold, or holds through the next call too; Cancel is unavailable while audio connects.
- "Started by mistake?" offers to throw away a real meeting, discards a different one, or lets a paired pet delete any meeting; "Your notes are ready" appears for another computer's meeting, appears twice, or opens the wrong page.
- A template chosen during the call is lost before the write-up; transcript search highlights other words than it filters by, or Copy ignores the search.
- Calendar pagination or secondary calendars are skipped; Google and Outlook IDs collide; declined, cancelled, all-day, or invalid-time events become recommendations; stale/failed calendar reads erase valid recommendations or appear current.
- A calendar listening request loses its title, attendees, or event association when the pet takes it. An invite opens an unsafe URL, or another renderer can trigger the notification's privileged actions.
- Electron does not boot, cannot load the sandboxed preload/worklet, or exits without a report.
- The fake microphone fixture is not captured, source clocks are wrong, no chunks reach the worker, silence is hallucinated, or ONNX cannot load in the real utility process.
- The system track is unavailable, dies after the video track is stopped, captures silence, or contains the microphone phrase instead of the independently played output phrase.
- macOS denial hangs or silently claims successful loopback; partial capture is not reported.
- The macOS call probe returns no script result, malformed JSON, a process error, or a timeout. A failure must retain stdout/stderr in the report and fail the probe instead of being mistaken for an idle microphone or permission refusal.
- Chrome exits before exposing DevTools on the Linux CI runner. Startup failures must include the browser's exit status and stderr; the UI check must still fail without a real browser page. CI-only Linux flags apply to the disposable profile used for synthetic local content.
- A reload assertion reads the outgoing document instead of persisted settings, or screenshot capture races navigation before a new frame is painted.
- Recreating the pet's UI destroys its independent capture window.
- Server delivery fails once and loses or duplicates segments; Stop drops the last phrase or finishes before the queue is drained.
- Write-up claims can be taken twice, stale results overwrite notes, typed notes disappear, generated lines lose outside-content provenance, or an action item creates duplicate to-dos.
- Stop/dispose leaves a worker, window, IPC listener, timer or database behind. A timeout leaves child processes running or suppresses failure artifacts.
- Closing the last capture window quits the probe before its transcript is saved. Like the real tray pet, the probe must stay alive until the queue drains; the playback window is closed before Stop so this is exercised on Windows too.
- CI accidentally uses the owner's home, credentials or installed pet; audio-driver setup runs on a persistent machine; a downloaded driver archive differs from the pinned checksum.

CI uploads reports even after failure and writes coverage to the job summary. Generated audio, databases and profiles are not committed or uploaded. The source harness is permanent CI coverage requested for this feature.

## Dashboard performance verification

The UI journey passed 27 checks on Windows against production build `288c776c-a66b-41f9-be6f-ddba8978e288` on 2026-11-27, with no uncaught browser errors. Completed and failed details had no one-second intervals. The live detail and meeting list each used one shared elapsed-time clock; the duration advanced during recording, stayed fixed after completion, and the shared clock stopped after navigating from the live detail through the list to a failed meeting. The writing warning stayed hidden before five minutes and appeared after the deadline using a real five-second timeout with only the disposable browser's wall clock offset. A writing row without an end time showed no invented duration. Existing note editing, transcript search, mobile layout and saved speech settings passed in the same journey. The fixture backend, Chrome profile and temporary home were closed and removed.

Reproduce after a production build:

```shell
pnpm exec bun build artifacts/meetings/deadline-probe.tsx --target browser --format iife --minify --outfile node_modules/.cache/meeting-deadline-probe.js
pnpm exec node --experimental-transform-types --import ./artifacts/security-audit-20261028/loader.mjs artifacts/meetings/ui.mjs <output-directory>
```

The output includes `ui.json` and a screenshot of the deadline warning. These checks use synthetic meetings and do not call paid model APIs or record the owner's microphone.

The review follow-up passed 40 checks on production build `7b06a11d-acda-4eef-8aca-11fe3c6d3f45`, with no uncaught browser errors and the temporary home removed. Thirteen checks exercise the actual shared hook in native React and Chrome inside a disposable frame. Advancing its wall clock in a layout effect guarantees the deadline crosses after render and before passive effect setup. The previous hook failed only `crossedDeadlineWakesOnce`, scheduling no wake; the fixed hook scheduled exactly one 1 ms wake and then stayed idle. The same probe covers expired/nonfinite times, successive deadlines, replacement, unmount cleanup and the browser's maximum timer delay. The full meeting journey still checks the visible writing warning and active/completed clocks. Its ordinary note-query updates can incidentally rerender the page, which is why the isolated lifecycle replay is needed to expose the race.

Automatic approval review rejected removal of the fresh report directory, `node_modules/.cache/performance-meetings-20261127`, with `blocked by policy`. The synthetic fixture home was removed automatically; only the report, screenshots and server log remain in that output directory.

The same review blocked cleanup of the follow-up `performance-deadline-*` and `performance-meetings-commit-baseline` report directories under `node_modules/.cache`. Their fixture homes and browser profiles were removed automatically. Temporary baseline source copies and generated probe bundles were removed separately; the maintained probe source remains.
