# Native progress adapter replay

Inventory before adding the replay:

- Streamed Claude SDK assistant events deliver text and tool blocks separately with the same message ID; completed text must survive until its own tool event arrives.
- Multiple text/thinking blocks must retain distinct block indices. Repeated completion, another message ID, aborted content or child-agent metadata must not duplicate or publish stale progress.

- A partial text delta, reasoning item, final answer or a child thread becomes an owner progress message.
- Completed Codex commentary is dropped, or an early item arriving before turn/start returns is lost.
- Claude publishes child-agent text or a text-only final answer; complete text attached to a parent tool-use message is lost.
- Repeated provider completion, late deltas or terminal draining duplicate or reopen completed progress in TurnTrace.
- Another thread or stale native turn contributes progress to the active turn.
- Completion, provider failure or interruption leaves native listeners or live turns behind.
- Verification launches a real CLI/model, uses the owner's files or network, or loses its bounded JSON evidence.

The replay drives the real engine runTurn methods with a synthetic Codex app
transport and a synthetic Claude SDK iterator. Only Claude binary discovery and
the SDK query boundary are substituted. No model or external service is used.
