# Usage-limit handoffs (#189 follow-up)

The main agent's web turn can continue on another signed-in engine after a plan limit interrupts its text or completed actions. The handoff carries the original request, chat history, recalled context, partial replies and redacted step excerpts. It tells the next engine to continue and verify current state rather than repeat completed actions. This is an agent instruction and evidence transfer, not an exactly-once guarantee for arbitrary external side effects.

Each engine is attempted at most once within the same run. Engine changes and their reason appear in Activity. The original request and final answer are saved once. An outside-read guard remains active across attempts. Stop and Pause also cancel a turn during the routing gap.

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

The full run includes a completed synthetic action followed by a limit. The next engine must receive both its recorded result and partial reply. The action counter must remain at one.
