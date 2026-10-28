# Security audit verification failure inventory

Written before the audit harness. No application implementation is changed.

The HTTP replay uses real route handlers, validators, schema, Runtime and SQLite behind a disposable loopback HTTP adapter, not a deployed Next.js server. It must never start an engine, load an existing Perry home, contact a provider, or run an uploaded script on the host. Only synthetic data is used.

Cases to exercise:

- Missing/wrong dashboard keys, wrong runner tokens, revoked device keys, and public attempts to call internal functions must fail before protected data is returned.
- Every public backend definition must be inventoried, including authentication delegated to helpers. Static inventories alone cannot prove authorization.
- A stored active HTML/SVG attachment may retain its supplied MIME type and execute on the dashboard origin; record its headers and body without executing it in a privileged browser.
- An upload with an invalid ticket may read its body before rejecting it; bound the probe to a few bytes and record whether the body is consumed.
- A one-use upload ticket may admit concurrent replay; only one submission should succeed.
- Anonymous event streams may consume listeners/timers, lack a connection quota, fail to clean up on cancel, or leak on an already-aborted request. Bound the replay to 12 streams and cancel each.
- A saved file approval may accept dot-segment traversal, an unrelated sibling, a different drive or an unapproved path. Test approval decisions only, never perform a write.
- Racing approval decisions or two claims of a queued turn may both win. Check durable state afterward.
- Concurrent note saves based on the same revision may overwrite silently; only one should succeed.
- Replaying the same chat submission after an uncertain response may enqueue duplicate work despite a stable message key.
- Failed Telegram ingestion may advance the polling offset and permanently skip the update. Use a fake local Bot API and an injected ingestion rejection; no Telegram traffic.
- A stalled outbound request may lack a deadline and prevent later work. Check source and use bounded adapters where reproduced; never wait indefinitely.
- Cache invalidation may show stale/revoked/redacted data, ignore a reconnect, or fail to cancel pending network requests on close. Distinguish existing coverage from fresh probes.
- Declared indexes may not exist, fail to match query expressions, or require temporary sorts. Inspect the real generated SQLite index list and EXPLAIN QUERY PLAN; do not extrapolate synthetic timings to production.
- Scheduler failures, storage deletion rollback and WAL durability can differ from claimed guarantees. Record source evidence and distinguish crash windows from experimentally reproduced outcomes.
- Security headers, Origin validation, connection limits and rate limits may be supplied outside these handlers. The adapter cannot establish actual Next.js, reverse proxy, Tailscale or Vercel behavior.
- Dependency scans may conflate advisory instances with unique advisories and installed packages with exploitable features. Preserve raw registry responses and state applicability separately.
- Every fixture listener, server, timer, database and temporary home must close even when a check throws. Preserve a JSON result as the repeatable artifact.
# Deletion sweeper interleaving

An asynchronous mutation can yield after creating a deletion tombstone but
before commit. A scheduler tick must wait behind that mutation; otherwise it
could unlink bytes for a deletion that subsequently rolls back. Exercise the
real delete-chat handler, pause before its commit, start a scheduler tick,
confirm the bytes still exist, then force rollback and verify both bytes and
metadata survive after the tick finishes.

# Production deployment acceptance

Start only the compiled Next server in a disposable Perry home, with no runner
or provider credentials. Verify headers are actually emitted on dashboard
pages, API media remains same-origin embeddable, active uploads download, and
the real dashboard loads in isolated Chrome without browser errors. A failed
request, missing build, child exit, or browser failure must still stop the
server and save a result; never point this replay at the owner's installation.
The shared Chrome harness can itself fail before returning its handle. Close
its WebSocket and process on that path too, and include the rendered page and
browser errors so a selector failure cannot be mistaken for a passing app.

## Review follow-up failure inventory

- An active query deadline can leave the initial page unloaded forever without
  a change-stream event. Retry with bounded backoff, cancelling retries on
  unsubscribe, cache invalidation and close. Intentional cancellation must not retry.
- A write can commit before its response times out. Surface an unknown outcome,
  never automatically replay it, and verify exactly one durable change remains.
- Lexical normalization can erase a symlink before `..`. Refuse automatic rules
  for parent-segment paths; exercise real symlinks/junctions and saved-rule decisions.
- A UNC file directly under a share must not offer an entire-share permission;
  a file beneath a share subdirectory can offer that narrower directory.
- An action's metadata delete and tombstone insert must roll back together.
  Inject a SQLite tombstone-insert failure and verify metadata/bytes survive.
- One hundred failed unlinks must not starve later removable files. Simulate
  failures with directories at synthetic file paths, then verify later cleanup.
- Importing an ID with a pending tombstone must serialize file bytes and metadata
  with the sweeper. Hold the Runtime queue to prove no pre-queue filesystem write.
- Rollback probes must clear all synthetic scheduled jobs before ticking; assert
  the scheduler remains empty so approval delivery cannot run during the probe.
- Large uploads need a bounded size-scaled deadline, while ordinary JSON stays
  bounded at 30 seconds. Cancellation, size limits and admission must still work.
- Browser diagnostics and CDP requests must settle after disconnect or timeout;
  every deadline must clear and cleanup must run even if diagnostics fail.
- Historical and current replay outputs must never overwrite committed snapshots
  or each other. Check output paths and preserve baseline-only evidence links.

