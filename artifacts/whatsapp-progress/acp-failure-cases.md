# ACP progress replay

Inventory before adding the replay:

- A replay timeout while runTurn or interrupt is pending must cancel the active engine and await its subprocess before another scenario or temporary-home removal begins.
- If exit confirmation itself times out, fail the whole replay, remove exit/error listeners, and retain the home. A delayed confirmation must finish before cleanup. Nested replay probes with withheld/delayed confirmation must verify scenario stopping and home retention, without leaving real child processes behind.
- An error notification from a process with a live PID is not proof of exit; the observer must still wait for termination.
- The expected-deadline assertion must propagate unconfirmed termination unchanged. Deadline probes must withhold exit confirmation, verify that no later scenario starts, and retain the home even if an assertion wraps the underlying cleanup error.

- The first assistant chunk or a final-only answer is published prematurely as progress.
- Thinking, tool results, user replay or another session's messages become owner progress.
- A tool call after complete user-facing text fails to close that progress segment, or repeated tool updates publish it twice.
- Two assistant/tool iterations merge unrelated updates or repeat the entire progress transcript as the final answer.
- Empty text at a tool boundary produces an update; no post-tool final text loses the last useful assistant message.
- Native cancellation/provider failure leaves the ACP process, active session, watcher or request alive.
- The replay launches a real engine, installs Antigravity, calls a model/provider, or touches the owner's state.
- A failed replay loses JSON evidence or its disposable home and child processes.

All three real subclasses (Grok, OpenCode, Antigravity) run the shared AcpEngine
against a local synthetic ACP subprocess using the installed SDK. Binary launch
is substituted only for the fixture. The replay claims protocol behavior, not
acceptance by real provider services.
