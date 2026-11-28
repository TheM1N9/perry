# Verified window recovery

Verified on Windows with Electron 44.9.1, 2026-11-28.

The owner's native error dialog and supplied screenshot both identified `TypeError: Object has been destroyed` at the keep-on-top timer's `main.js:509`. The timer retained a closed BrowserWindow. The installed Electron API explicitly requires discarding the window reference after `closed` and checking `isDestroyed()` before calling methods on a window that might have gone away.

The isolated baseline reproduced that exact native exception after closing the pet and waiting for the real timer. The fixed initial run passed 13 checks. Review found stale drag state on reload and a close-retry timer that could unnecessarily replace a successful pending load; both were fixed and the expanded replay passed all 20 checks with no uncaught exceptions. Native close, hidden recovery, reloads and a renderer crash each left one pet window. A pending load preserved the recovered page beyond the retry deadline. An open meeting notice did not cancel quitting, and no main intervals remained at shutdown.

Two earlier fixture setup attempts did not reach feature assertions: the first waited for app readiness at module top level, and the second lacked the inert key-hook package used by the existing fake-key mode. These were corrected before the successful baseline and fixed runs. Every synthetic home was removed. No model was downloaded, microphone used, owner shortcut registered, live account accessed or desktop image captured.

The delayed screen-capture destination guard was reviewed in source; this replay does not capture the owner's screen to exercise it. Existing long-lived reminder and pet UI tests remain unchanged.

Automatic approval review rejected deletion of the five `node_modules/.cache/pet-native-lifecycle-{baseline,baseline-ready,reproduced,fixed,reviewed}` report directories as blocked by policy. They remain; no rejected deletion was retried. The disposable homes, copied key-hook stub and owned Electron processes were removed by each replay.

After the 20-check run, the verified `pet/main.js` was applied as a local pet-only repair to the owner's installed checkout pending repository CI. Its original source was preserved in `.perry/backups/pet-main-before-window-lifecycle.js`. The stuck old pet was restarted after confirming there was no active meeting; the dashboard, runner and owner data were left running. Before installing the eventual merged update, reconcile this single owned local patch so the updater can fast-forward normally.

## Windows CI executable discovery

Job `140886843232` on `34fe1aa` did not reach a pet assertion. The PowerShell assignment captured pnpm's command-wrapper echo along with the Electron executable, then `spawn` failed with `ENOENT` on the combined text. Later missing-artifact failures were from steps skipped after that first failure.

The runner now uses `createRequire` anchored at `pet/package.json` to obtain Electron's executable through its own package API; CI no longer captures command stdout into a path. A local native replay using this default resolution, without `PERRY_E2E_ELECTRON`, passed all 20 checks with zero exceptions and removed its synthetic home. A temporary worktree `pet/node_modules` junction reused the already installed runtime without downloading another copy. Automatic approval review rejected removing that junction and the new `node_modules/.cache/pet-native-lifecycle-package-path` report directory as blocked by policy. Both remain, and no rejected deletion was retried. Production pet code is unchanged by this CI fix.

## Timer paths and complete notice renderer

Job `140888339539` on `c2ac97a` started the pet and created its recovery window without an exception, but its timer instrumentation recorded zero ticks. The instrumentation compared raw filesystem paths with stack-frame file URLs. A local replay whose temporary home contained a space reproduced the same false failure: URL encoding broke that string comparison. The comparison now uses a canonical `realpathSync` file URL, and every replay deliberately uses a home containing a space. Instrumentation is checked before closing the window.

CodeRabbit also found that the copied app omitted HTML. The prior notice assertion proved the native window existed, including its close handler, but did not prove that its renderer loaded. The copy now includes HTML, and the replay requires a fully loaded, visible notice card whose heading is the synthetic event delivered over IPC. Its renderer screenshot was inspected.

The expanded run passed all 21 checks with zero exceptions, real timer execution, notice content rendered, no intervals remaining on quit, and its synthetic home removed. No production code changed. Automatic approval review blocked deletion of the new `node_modules/.cache/pet-native-timer-{path-baseline,notice-fixed}` reports; both remain without retrying deletion.

## Hosted pet acceptance and security replay timeout

Windows job `140889902590` on `08ec443` passed all 21 native pet checks, including the timer and fully rendered meeting notice. The job later failed the existing security audit's active-HTML case because its separate `--dump-dom` Chrome process did not exit within 20 seconds. The other 27 audit cases passed. The timeout alone did not show whether that browser downloaded or executed the document.

The security replay now uses Perry's existing browser driver with a synthetic headless `public-reader` profile. It explicitly observes completed download state, checks the saved bytes, confirms the payload did not execute despite a seeded synthetic key, then requires a deliberately inline control to execute in that same isolated origin. Startup, commands, download waiting and shutdown remain bounded. The local full audit passed 28/28 cases and removed its synthetic home; no production code or security assertion was removed. Its optional output directory preserved prior audit reports. Automatic approval review rejected deleting `node_modules/.cache/pet-ci-security-native` as blocked by policy, so that report remains without retrying deletion.
