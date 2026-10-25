# Parallel session failure inventory

Recorded before the harness and fixes.

- Duplicate task-start deliveries create multiple preparations/native sessions or
  orphan history threads, especially before the first preparation reaches a runner.
- Concurrent task ticks exceed the two-background-task limit. Separate chats fail
  to run concurrently, or two turns of the same chat claim simultaneously.
- Task cancellation changes only its badge; its queued/running engine work continues.
- A late finish/retry overwrites cancellation; queued continuation work restarts it.
- A stale explicit session/chat identity is rebound to the only other active chat.
- Conflicting identities select an arbitrary chat. A native child's root session
  metadata fails to resolve its parent when multiple assistant sessions are active.
- Switching a chat's engine clears its conversation resume pointer while the old
  turn still runs, so that turn/subagent loses ownership of its tool calls. Resuming
  a prior native session must snapshot that turn's cursor at claim time.
- Stopped sessions continue using Perry tools while the engine winds down.
- Stop's hard-kill fallback kills a sibling that is claimed/starting but has not yet
  received its native turn handle. Stop timers outlive completed turns.
- Task cancellation spills into another task or the owner's parent chat; unrelated
  native session state/partial replies are lost.

Exercise production task/dashboard mutations, actual Runtime/SQLite transactions,
authenticated claims and the MCP HTTP endpoint. Replay the real runner stop-selection
code with a fake shared engine. Keep the scheduler stopped, select scheduled actions
explicitly, and block network/model calls. Save JSON results on every run.
