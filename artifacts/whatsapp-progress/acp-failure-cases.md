# ACP progress replay

Inventory before adding the replay:

- A replay timeout while runTurn or interrupt is pending must cancel the active engine and await its subprocess before another scenario or temporary-home removal begins.

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
