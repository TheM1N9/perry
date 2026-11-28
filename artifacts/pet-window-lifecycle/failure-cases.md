# Pet window lifecycle failure inventory

Written before the native Electron reproduction and implementation changes.

- Closing or destroying the current pet window leaves a non-null reference. The 15-second keep-on-top timer, tray controls, display handlers or meeting anchor then call a destroyed native object.
- Recovery creates no replacement window, creates more than one, loses the saved position, or shows a pet the owner hid.
- Destroying an old window during reload clears the reference to its replacement or schedules another reload.
- A late load/renderer callback touches a destroyed window after replacement.
- A second load overtakes a pending request, or a request completes during quit and creates another window.
- Timers, file watchers and screen/power listeners keep running during shutdown.
- A delayed screen capture finishes after its destination window closes and sends or focuses the wrong window.
- The replay modifies the owner's profile, shortcuts, clipboard, autostart, microphone, notifications or model cache.
- Failure leaves a disposable Electron process, local HTTP server or synthetic home behind.
- Capturing a package-manager command's stdout as an executable path includes wrapper command echoes on a hosted Windows runner, so Electron never starts.
- Timer instrumentation matches an unencoded or aliased filesystem path against canonical file URLs in stack traces, so it reports no ticks although the native interval ran.
- Copying JavaScript without its HTML creates a notice window whose renderer failed to load; checking the window identity alone incorrectly passes shutdown coverage.

Use a local synthetic page and the real Electron main process and BrowserWindow APIs. Capture uncaught exceptions as failed evidence instead of blocking the replay on Electron's native error box. Keep the real 15-second timer. Record window identities, recovery, shutdown and cleanup in repeatable JSON, without paid model calls or live account access.
