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

## PR review regressions

Record before extending the E2E and editing the fixes:

- An open CDP transport that never answers `Page.stopLoading` holds the browser
  lock for 30 seconds. Cleanup must release it promptly and invalidate/close the
  old host so a delayed stop cannot interrupt a later action or another chat.
- A setup error after the fixture starts listening bypasses all teardown and
  result handling. Cover module initialization and Runtime construction failures,
  and verify bounded process exit, server closure and a saved failure artifact.
- A native permission's JSON scope or its reason exceeds the approval detail
  limit. Never offer a truncated scope for approval while granting the full one.
  Keep the entire scope visible, shorten only explanatory text, and decline
  before creating a request when the scope itself will not fit. Check the exact
  boundary, oversized reason, oversized scope and missing scope in Ask/Auto/Full.
