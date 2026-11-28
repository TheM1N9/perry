# Verified window recovery

Verified on Windows with Electron 44.9.1, 2026-11-28.

The owner's native error dialog and supplied screenshot both identified `TypeError: Object has been destroyed` at the keep-on-top timer's `main.js:509`. The timer retained a closed BrowserWindow. The installed Electron API explicitly requires discarding the window reference after `closed` and checking `isDestroyed()` before calling methods on a window that might have gone away.

The isolated baseline reproduced that exact native exception after closing the pet and waiting for the real timer. The fixed initial run passed 13 checks. Review found stale drag state on reload and a close-retry timer that could unnecessarily replace a successful pending load; both were fixed and the expanded replay passed all 20 checks with no uncaught exceptions. Native close, hidden recovery, reloads and a renderer crash each left one pet window. A pending load preserved the recovered page beyond the retry deadline. An open meeting notice did not cancel quitting, and no main intervals remained at shutdown.

Two earlier fixture setup attempts did not reach feature assertions: the first waited for app readiness at module top level, and the second lacked the inert key-hook package used by the existing fake-key mode. These were corrected before the successful baseline and fixed runs. Every synthetic home was removed. No model was downloaded, microphone used, owner shortcut registered, live account accessed or desktop image captured.

The delayed screen-capture destination guard was reviewed in source; this replay does not capture the owner's screen to exercise it. Existing long-lived reminder and pet UI tests remain unchanged.

Automatic approval review rejected deletion of the five `node_modules/.cache/pet-native-lifecycle-{baseline,baseline-ready,reproduced,fixed,reviewed}` report directories as blocked by policy. They remain; no rejected deletion was retried. The disposable homes, copied key-hook stub and owned Electron processes were removed by each replay.

After the 20-check run, the verified `pet/main.js` was applied as a local pet-only repair to the owner's installed checkout pending repository CI. Its original source was preserved in `.perry/backups/pet-main-before-window-lifecycle.js`. The stuck old pet was restarted after confirming there was no active meeting; the dashboard, runner and owner data were left running. Before installing the eventual merged update, reconcile this single owned local patch so the updater can fast-forward normally.
