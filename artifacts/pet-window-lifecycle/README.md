# Native pet window lifecycle replay

This launches Perry's real Electron main process and native windows against a local synthetic HTML page. It needs installed root dependencies and the pet's pinned Electron runtime. It uses a separate `PERRY_HOME`, copies the pet files into it, and removes that home and its processes afterward. It does not start the owner's pet, change autostart, use the clipboard or microphone, take a desktop screenshot, or download models. The key hook and shortcut registration are inert; the native window lifecycle and real 15-second keep-on-top timer run normally.

```powershell
pnpm exec node artifacts/pet-window-lifecycle/run.mjs node_modules/.cache/pet-window-lifecycle
```

The runner obtains the executable directly from the installed Electron package, without parsing package-manager stdout. Set `PERRY_E2E_ELECTRON` to another existing Electron executable when reusing an installed runtime. Add `--baseline` to replay the main process from `b297765b90a008a3598f8bdcc8b1518d85c1832e` in the same disposable environment. The baseline fails with the exact `Object has been destroyed` exception at `main.js:509` after native window closure.

The JSON report records checks, uncaught exceptions, window creation, timer execution, exit and cleanup. `recovered.png` captures only the synthetic renderer. The fixture records exceptions instead of opening Electron's blocking error box; any recorded exception still fails the run. Remove output files after inspecting them. Keep the replay and its failure inventory.

Coverage includes native close/destroy, three page reloads, saved position, mid-drag reload and closure, hidden recovery and tray Show, renderer crash recovery, a pending HEAD completing before the close-retry timer, and quit with both a pending request and an open meeting notice. Shutdown also verifies recurring main-process intervals are cleared. Voice recognition, real screen capture and pointer injection are outside this replay.

The temporary home contains a space to exercise file-URL encoding. Timer ownership uses the canonical source URL, including Windows path resolution. The notice case verifies the copied HTML and JavaScript render the event received over IPC before testing shutdown; its renderer is captured as `meeting-notice.png`.
