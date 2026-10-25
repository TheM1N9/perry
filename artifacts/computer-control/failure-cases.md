# Computer-control failure inventory

Record before the E2E harness and fixes. Use an isolated Runtime/SQLite, the
real MCP endpoint, a dedicated Chromium profile, and a loopback-only fixture.
Never use the owner's browser profile, desktop, credentials, or a live model.

- Chat Stop or global Pause leaves a browser call waiting for approval; a late
  approval still executes the action, including after its native turn ends.
- An aborted HTTP/tool request leaves browser work running or the chat busy.
- Cancellation interrupts a different chat's browser or prevents later turns
  from deliberately using their own browser.
- A later snapshot reassigns element numbers without invalidating the earlier
  identity, so an old ref clicks/types/selects a different control.
- DOM navigation during observation binds old page content to a new identity.
- Arrow, Delete, Home/End and modifier shortcuts do nothing because key events
  omit platform key codes. Text entry, Enter, Tab and Backspace regress.
- Owner input queued before a tab/chat change lands in the new page; unmount
  leaves scroll/keyboard work alive. Note separately if not reproduced here.
- Browser close/restart while launch is pending leaks a child/browser session.
- Repeated tab closure/downloads retain connections/history indefinitely.
- Cancellation leaves approval polling, CDP command timers or load listeners
  alive; teardown must run on normal completion, errors and abort.

Save JSON checks, observed values, browser/version, and failure details on each
run. A failing check must continue far enough to release all fixture gates.
