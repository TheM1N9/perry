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
