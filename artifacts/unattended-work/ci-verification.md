# Windows replay transport failure

The Windows job on `8761ae1` failed one of 32 cases: `withdrawal after external IO remains uncertain and is never replayed`. Its saved stack shows the local HTTP `notify:releaseHeld` request failing with `TypeError: fetch failed` after the synthetic SQLite Runtime restarts. The artifact does not include the underlying socket cause, so a stale pooled connection is a transport hypothesis, not a confirmed product defect. All other cases and temporary-home cleanup passed. Later missing-artifact errors came from skipped steps.

The unchanged replay passed all 32 cases on the current source. Before changing the fixture, the relevant failure modes are: a local connection closes between native-runtime phases; an ambiguous mutation is retried and duplicates delivery; pending external IO is released too early; or closing transport also suppresses the delayed delivery/cancellation assertions.

The fixture will explicitly close each loopback response connection. This uses HTTP connection management without retrying mutations or changing production delivery behavior. The real Runtime/SQLite/HTTP journey, pending external-request gate, restart and no-replay assertions remain intact.

With explicit response connection closure, the maintained native replay passed **32/32 cases** on Windows. The cancellation-after-IO result remained uncertain, was not replayed after SQLite restart, and its temporary home was removed. The unchanged current-source replay also passed 32/32 before this transport change. These observations do not establish the original socket error's underlying cause; fresh CI remains the cross-platform check.

Reproduce from the repository root with `pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/unattended-work/run.mjs <output-directory>`. Each run writes incremental JSON evidence; use synthetic credentials and the replay's local fake endpoints only.

Automatic approval review rejected deletion of the reviewed output directories `node_modules/.cache/unattended-ci-389`, `unattended-ci-389-failed`, and `unattended-ci-389-fixed` as blocked by policy. They remain; deletion was not retried. Both local runs removed their synthetic homes.
