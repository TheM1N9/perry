# Proactive heartbeat verification

Run from the repository root with Node 25 and installed dependencies:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/proactive-heartbeat/run.ts
```

The journey uses Perry's real SQLite runtime, scheduled job functions, memory,
and notification admission in a fresh home under `node_modules/.cache`.
It writes `result.json` and `heartbeat-prompt.txt` here. No real accounts,
model calls, or outgoing messages are used. The model's finding is a fixture;
this checks the lifecycle, not whether a model can detect a real email error.

Failure cases recorded before writing the verification script:

- Fresh installs keep the old four-times-a-day schedule.
- An upgrade resets a custom schedule, unpauses a job, duplicates a built-in,
  or leaves the next run on the old schedule.
- An investigation queues a second turn while its previous turn is pending.
- A failed or partially checked run advances the lookback and loses activity.
- Prompt context leaks project or guest chats, grows without a bound, omits
  the owner's timezone or earlier alerts, or lacks sent-mail/thread checks.
- Autonomous turns can begin without the existing outside-data restrictions.
- A finding is never queued for delivery or never reaches alert memory.
- The same finding is queued again, including after a runtime restart.
- A changed finding is suppressed because it shares the first 600 characters
  with an earlier alert's truncated memory.
- NOTHING produces a notification, or heartbeat delivery bypasses quiet hours.
- Pausing Perry still allows a new heartbeat investigation to start.

Live connector discovery, provider pagination, model judgment and the quality
of source links still need an end-to-end run with connected test accounts.
