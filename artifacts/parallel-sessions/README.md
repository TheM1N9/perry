# Parallel agents and assistant sessions

Perry has three distinct layers:

- The runner allows four simultaneous turns by default (`PERRY_MAX_TURNS`).
  Separate chats can run concurrently; a chat's own turns remain serial. Engines
  that do not support concurrent turns are serialized by the runner.
- The background-task scheduler admits two tasks at once. Each has its own
  conversation/history, native engine session, queue, plan and result. Cancelling
  a task stops its own preparing/queued/running turns and releases its task slot.
- Native subagents spawned inside Codex or Claude are managed by that engine.
  They are not separate Perry dashboard chats or independently scheduled Perry
  tasks. Their internal parallelism is not bounded by `PERRY_MAX_TURNS`.

The audit reproduced six failures before implementation (`baseline.json`): a
late explicit session identity could act on another chat; task cancellation did
not interrupt its turn; a late task update could overwrite cancellation;
duplicate task starts scheduled two preparations and created an orphan history
thread; and Stop's hard-kill fallback could kill a sibling still starting on the
same shared engine.

Task admission now reserves the existing durable turn queue inside a mutation,
so duplicate starts and cancellation serialize with it. Cancellation interrupts
the task's own turns, and the update guard atomically rejects late completion.
Hard Stop accounts for claimed/starting siblings even before their native turn
handle arrives; its grace timer is cleared on turn completion.

Each running turn now retains its native session cursor. Changing the chat's
engine no longer detaches an old turn or its subagents from their tool context.
The MCP endpoint resolves the supplied native parent/root identity or Perry chat
header, rejects stale/conflicting identities, and refuses new calls after Stop.
The legacy single-turn fallback remains only for callers that omit identity.

Stopping an ordinary chat does not implicitly cancel independent background
tasks that originated there. Cancel those tasks from Work. This change does not
add a T3-style child-agent tree, cross-provider delegation, or independently
addressable native subagent chats. A child without verifiable parent metadata
is refused rather than assigned to a currently running sibling.

If a shared engine ignores its normal interrupt, the fallback stops waiting for
the targeted turn while preserving the shared engine. It cannot guarantee forced
termination of that engine's native children without engine-specific lifecycle
support. Native child execution/termination was not exercised by this fixture.

## Repeat

From the repository root, with installed dependencies and Node 25:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/parallel-sessions/run.ts
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/message-lifecycle/run.ts
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/task-steering/run.ts
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/tool-approval-routing/e2e.ts node_modules/.cache/perry-parallel-approvals
pnpm exec tsc --noEmit --incremental false -p convex/tsconfig.json
pnpm typecheck
pnpm exec powershell -NoProfile -File artifacts/batch-1/run-isolated.ps1 -Mode Build
```

The parallel-session harness writes `result.json` on every run. Its 25 checks
use real Runtime/SQLite, dashboard/task mutations, selected scheduled task/brain
handlers, authenticated fake runner claims and the actual MCP HTTP endpoint.
It replays the production runner's hard-stop selection against a fake shared
engine, including a sibling without an engine handle yet. Local embedding
compute is replaced by a deterministic fixture. Network is blocked and the
scheduler remains stopped; no real model, installed service or account is used.

The failure inventory preceded the harness. `verification.json` records the
final checks and source hashes. Native child routing is verified with protocol
metadata fixtures, not live native subagent execution. The existing real-model
`artifacts/parallel-turns/run.ts` suite was inspected, but was not rerun.
