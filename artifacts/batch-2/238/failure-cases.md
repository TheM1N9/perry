# Isolation and behavioral failure cases (before E2E code)

- Dynamic imports could derive the real home or read dotenv: set synthetic PERRY_HOME, PERRY_DB, DASHBOARD_KEY and credential key before imports; never import server/index or runner/index.
- An action could contact a live endpoint, spawn an engine, start a scheduler, or mutate other peers: deny all fetch except the in-memory fake Telegram endpoint; no engine/CLI invocation; stop Runtime before first mutation; use only this issue's disposable fixture and virtual integration modules.
- Fixture paths could escape scratch or fill storage: resolve/check the issue-root descendant, use an in-memory SQLite DB except one bounded restart fixture, remove own fixture DB after closing, enforce total scratch <20MiB.
- Snapshot writes could stay quadratic; metadata reads could subscribe to chunks indirectly; heartbeat/TG writes could invalidate turns per flush: instrument actual Runtime read/write table sets and actual SQLite row-write payload bytes with triggers, separately count scheduled heartbeat writes.
- Concurrent sends, lost acknowledgments, duplicate appends, failed requests, reset/rewrite events, cap overflow or invalid offsets could lose/reorder text: serialized acknowledged offsets, retries, bounded length, explicit replacement.
- Finalization/cancellation could race an in-flight flush, lose the last delta or trace, or replay a result incorrectly: drain stream before finish; save final fallback text before network; replay persisted result; verify trace settlement and idempotent finalization.
- Legacy partial rows, legacy snapshot runners and server restart could lose text: fallback reads, snapshot compatibility, reopen SQLite and read through production queries.
- Telegram drafts and final Telegram/WhatsApp could miss streamed fallback, create duplicate drafts or expose secret/memory footer: shared body helper, dedicated stream bookkeeping, fake delivery and replay checks.
- Secrets may straddle chunk boundaries, be saved after streaming, or reappear when offsets change: redact after assembly, scrub persisted chunks through vault integration while preserving source offsets, exercise split boundaries.
- Recovery/retry/heartbeat semantics could regress: use batch1 health/check-in/recovery and refused-attempt paths, keep terminal guards, run coordinator-owned combined build/UI separately.

## Integrated lifecycle follow-up (recorded before extending E2E)

- A draft action may read running state, then block in Telegram while finish/finalize delivers a new message; its late first send creates a duplicate or its late edit overwrites the final answer. Hold fake send/edit calls across finish/finalize and verify completion ordering. Also test a queued draft starting after finalization.
- A reset can commit, lose its acknowledgment, then have its chunks scrubbed by vault.save before retry. Reapplying that reset may resurrect the erased plaintext. Hold the exact failed reset packet across a real vault scrub; require its replay to be idempotent, followed by a newer append at source offsets.
- Production imports may accidentally still use old virtual sources after integration: default existing E2E to actual source, name its artifact explicitly, and reserve explicit proposal mode for follow-up shared patches.
- Process-local Telegram action ordering must release on rejected operations and retain existing durable finalize ownership/recovery; it must read the turn after acquiring ordering, not use a pre-lock snapshot. Never hold Runtime.exclusive while awaiting network.
- Follow-up delivery ordering could wait on itself if an action recursively invokes same-turn finalize, or wait forever behind a fetch with no deadline. Add native AsyncLocalStorage same-turn recursion rejection. Extend fake-request E2E with a reentrant production finalize invocation and a hanging request that rejects only when the actual draft AbortSignal.timeout aborts. A draft deadline must also cancel any Telegram 429 retry delay, while final/file delivery behavior remains unchanged.

## PR review: terminal storage cleanup (before E2E extension)

- Deleting chunks at finish/recovery could lose text or the Telegram draft ID
  before delivery. Keep them until markFinalized wins its existing terminal guard.
- Finalization could leave a second reply copy forever, delete another turn's
  stream, break retry ownership or make delivery replay duplicate a message.
- Assert zero stream metadata/chunks after stopped, failed, recovered and
  successful finalization; response/history must survive repeated finalization.
  Existing held Telegram and restart journeys must still pass. Record cleanup
  before orphan pruning so pruning cannot hide a leak.
