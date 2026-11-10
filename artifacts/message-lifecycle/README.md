# Message lifecycle verification

This change was compared with the installed T3 Code dispatcher, particularly
`resolveDeliveryIntent`, `ThreadManagementService.sendToThread`, and the stop
workflow. T3 records a message and its delivery intent before provider work;
automatic sends steer a running provider turn and queue during preparation.

Perry previously recorded dashboard sends in an outbox and decided delivery
after asynchronous preparation. Stop could miss that work, preparation could
reverse queue order, and a late follow-up could join a different reply.
`baseline.json` records the pre-change failure.

Perry now reserves an ordinary durable turn at acceptance. The reservation owns
its queue position, pending count, run and intended steering target. Preparation
fills it, converts it to a steer for that specific running turn, or leaves it as
a separate queued turn. Stop and Remove already operate on that same queue.
Ordered steering waits for earlier preparations and acknowledges one update at
a time. Refused steers retain their original queue position and attachments.

The dashboard offers Queue beside Send during a reply, and keeps Stop visible
with a draft. Stop cancels a media upload and restores the draft/files without
discarding newer typing. If admission is already crossing the network, Stop is
also applied after it acknowledges. The pet keeps Stop visible with a draft,
blocks duplicate sends and retains text/screenshots when a send is rejected.

Recorded Stop takes precedence over a late engine success/error; partial output
stays saved and cancellation cannot trigger a routing retry. Pause also visits
reservations with no runner yet. A preparation abandoned by a server restart
fails through existing recovery after five minutes and releases its pending
count when finalized.

## Repeat backend journeys

From the repository root with installed dependencies and Node 25:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/message-lifecycle/run.ts
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/task-steering/run.ts
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/turn-health/run.ts
pnpm exec tsc --noEmit --incremental false -p convex/tsconfig.json
pnpm typecheck
pnpm smoke
```

`run.ts` uses production handlers and real Runtime/SQLite in a fresh isolated
home under `node_modules/.cache/perry-message-lifecycle/`. The scheduler stays
stopped. It invokes selected scheduled actions explicitly, uses a stand-in
local embedder and authenticated fake runner reports, and blocks network access.
Most race cases control the preparation completion order at the handoff boundary;
one full journey runs the real `brain.handleTurn` from acceptance through history.
Every run writes `result.json`, including failures. The failure inventory was
written before the harness.

## Repeat the production browser journey

Build using the repository's isolated build wrapper. Start the existing
disposable production fixture in a separate terminal, then run the browser
journey:

```powershell
pnpm exec powershell -NoProfile -File artifacts/batch-1/run-isolated.ps1 -Mode Build
pnpm exec powershell -NoProfile -File artifacts/batch-1/run-isolated.ps1 -Mode UI
```

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/message-lifecycle/ui.ts
```

Stop only the disposable fixture process afterwards. The wrapper injects a
stopped Runtime before startup, blocks subprocesses and remote fetches, and
never starts the installed Perry or a real engine. The browser uses the existing
`artifacts/browser.ts` Chrome harness and removes its temporary browser profile.
The final run stopped Chrome, but automatic approval review blocked deleting
`W:/motionclip-storage-513/temp/perry-e2e-profile-xND6D3` with only the reason
"blocked by policy"; that temporary folder remains. The test server is stopped.
T3 preview inspection timed out twice, so this documented repository workflow
was used for browser verification.

The journey checks Queue/Stop in the dashboard at desktop and 390px widths,
preservation of an unsent draft, cancellation isolation between chats, an
aborted media upload with newer typing, and pet rejection/double-send behavior.
Its controlled upload stalls in the browser until its AbortSignal fires; no
file or model request leaves the fixture. It writes `ui-result.json` and PNGs.

No real provider session or Telegram/WhatsApp delivery was exercised. This
change addresses dashboard/pet admission, queueing and cancellation; it does not
add T3's interrupt-and-restart send mode. Production builds retain the existing
filesystem-tracing warnings in `convex/pet.ts` and `server/wake.ts`.
