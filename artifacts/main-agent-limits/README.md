# Usage-limit handoffs (#189 follow-up)

The main agent's web work waits for its selected engine when the provider reports a reset timestamp. Claude Code already reads ISO reset times through its native usage report; the runner refreshes that report after a limit before it finishes the turn. Perry waits until every exhausted window has reset, adds 15 seconds for clock skew, then resumes the selected model/session with its completed work. If the reset is unknown, an eligible signed-in engine can continue instead.

The wait and timer are persisted in SQLite through the existing scheduler. Recovery finds old waits by index, even behind a large chat history. A later weekly reset extends the wait. An offline computer keeps it waiting. Stop and Pause cancel it, and stale/duplicate callbacks cannot wake it. Queued follow-up messages retain their place behind the paused work. The composer shows the reported deadline instead of a replying indicator.

Engine changes and their reason appear in Activity. Each alternative engine is attempted once, with at most three automatic resumptions after reported resets within one request. The original request and final answer are saved once. Outside-read state remains active across attempts. The handoff carries the original request, chat history, recalled context, partial replies and redacted step excerpts. It instructs the next attempt to verify state and avoid repeating completed actions; arbitrary external side effects do not gain an exactly-once guarantee.

Progress handoffs require an owner web chat, at most 32 non-reasoning steps and 24,000 characters of partial replies across attempts. Every action must have a completed or declined trace. Unfinished/failed actions, missing legacy evidence, pending approvals, applied steers, media, guest/phone progress and maintenance turns retain the normal failure path. Empty refusals can route for those workflows under their existing restrictions. Jobs/tasks retain their existing reset-wait recovery.

Protocol checks, no network or model calls:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/main-agent-limits/e2e.ts W:/perry-qa/main-agent-limits-20261022/final
```

Full production app and runner regression, with isolated fake engines only:

```powershell
pnpm run build
pnpm exec bun artifacts/auto-routing/run.ts W:/perry-qa/main-agent-limits-20261022/auto-routing
```

The full run includes both a completed action followed by engine fallback, and a completed action followed by a reported reset. The same engine must resume only after the reset and safety margin, with its recorded step intact. Both action counters must remain at one. Claude-shaped protocol fixtures also cover five-hour/weekly overlap, restart, cancellation, unknown timestamps and queue order.
