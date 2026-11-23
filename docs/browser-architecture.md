# Browser host and native window

Perry uses Chromium through the Chrome DevTools Protocol (CDP). The dashboard
streams that same tab; it does not load the website in an iframe. Each chat has
its own persistent profile under `PERRY_HOME/browser/chats/<chat hash>`.

## What the T3 inspection established

The installed T3 Code Nightly desktop bundle was inspected locally at
`resources/app.asar/apps/desktop/dist-electron/main.cjs` on 24 November 2026.
Its `DesktopBrowserHost` drives Electron guest `webContents` through a CDP relay.
The `will-attach-webview` handler checks browser partitions, enables sandboxing
and disables Node integration. The user and agent operate the same guest page.

The host also manages focus and painting while a guest is captured, serializes
screenshots, drops detached sessions, and releases capture holds when work ends.
These lifecycle details matter as much as the browser toolbar.

Perry's Next.js dashboard cannot host Electron's native `<webview>`. The native
path implemented here opens regular Chromium in its own desktop window and
keeps the existing CDP host, profile isolation, agent tools and dashboard stream.
It is a separate window, not an embedded Electron view. Codex's proprietary
desktop implementation was not available for inspection; this change does not
claim to copy its internals.

## Launching

`server/browser-runtime.ts` prefers `PERRY_BROWSER_PATH`, then an installed
Chrome, Edge or Chromium. Chrome for Testing remains the fallback download when
no installed engine is found. Only the executable is reused; launch always
supplies Perry's chat profile, never the owner's personal browser profile.

Opening the browser from a local owner dashboard defaults to a native desktop
window on Windows, macOS, or Linux with a display. **Open in panel only** opts
into the background browser. Remote dashboard requests default to the background
browser and cannot explicitly request a desktop window. Agent-created browsers
continue to start in the background unless configured otherwise.

`PERRY_BROWSER_HEADED=0` disables the local native default;
`PERRY_BROWSER_HEADED=1` retains the existing headed-host override. These are
defaults; the local owner can explicitly choose a window mode when opening a
closed browser. Changing modes requires closing the current browser first.

Launch chooses an available loopback port before starting Chromium and passes
that actual port to `--remote-debugging-port`. Native mode uses Chromium's real
user agent and browser environment. It does not inject user-agent or WebDriver
property overrides.

Native windows retain their natural viewport size and remain open until closed.
The dashboard follows native tab selection and pauses automation when the owner
selects another native tab. Use **Pause & take over** before interacting with
the current native page while Perry is running. Closing the panel never resumes
automation. Closed tab connections are removed rather than retained indefinitely.

## Dashboard transport and input

- One CDP screencast per chat is shared by its viewers. Frames remain ephemeral
  and owner-only, with identity checks and bounded backpressure. Capture focus
  is enabled while streaming and released on stop.
- New frames update the image directly. They do not rerender the entire browser
  panel. Unchanged state messages also retain the previous React state.
- Pointer, wheel, text, keyboard and navigation requests share one owner queue.
  High-frequency pointer moves and wheel deltas coalesce while a request is in
  flight. Animation frames are scheduled only when input is pending.
- The viewer supports hover, press/release, drag selection, double/triple clicks,
  right clicks, two-axis scrolling, paste, composed text and keyboard shortcuts.
- The viewer has real history, forward/back, stop/reload, and panel/desktop/phone
  viewport choices. Owner navigation no longer waits for an agent snapshot that
  would invalidate input after the page appeared ready.
- The last viewer's disconnect, resize, tab selection and resume release pressed
  owner mouse buttons. Commands on closed sockets reject immediately instead
  of waiting for the CDP timeout.

## Verification and limits

A disposable E2E fixture exercised the real BrowserPanel, authenticated Next.js
routes, CDP host and installed Chrome 158 on Windows. The final run recorded
20 passing entries: 18 journeys and two observations. It covered navigation,
Unicode/composed text, shortcuts, hover, double/right click, native range dragging,
two-axis scrolling, stale input rejection after resize, history, takeover,
remount, disconnect during dragging, 375px dark layout, native window sizing,
native tab selection/closure, native browser environment, public Google sign-in,
and wrong-key/cross-origin rejection. Desktop and narrow screenshots were
inspected. The fixture did not enter credentials or complete account sign-in.

The native browser reported its normal Chrome user agent and
`navigator.webdriver === false`. Google's public sign-in identifier field
rendered. That is evidence for the launch path, not a promise that every website,
bot check, account policy or OAuth flow will accept it. macOS and Linux native
windows have not been exercised by this run. The panel remains a streamed viewer;
use the desktop window for the full native browser experience, including native
clipboard and browser context menus.

To repeat acceptance manually, open a new local chat, open its browser, navigate
to a test form, type and paste, select text by dragging, scroll a nested container
in both directions, change viewports, go back/forward, and close/reopen the panel
during a drag. Then select and close tabs in the desktop window and confirm the
dashboard follows. Check public Google sign-in without entering credentials.
Run `pnpm run typecheck` and `pnpm run build` after source changes.
