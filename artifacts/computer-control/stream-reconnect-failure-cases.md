# Native screencast reconnect inventory

Written before the standalone regression. The broader inventory in `failure-cases.md` already identifies this race. This bounded journey uses installed Chrome with a new native Temp profile, actual CDP responses, the production browser controller and `streamBrowser`, and actual loopback HTTP NDJSON readers. It uses no model, owner profile, connected account or shared Next build.

Failure conditions:

- The last viewer leaves while an owner pointer button is held, but cleanup never sends a native release.
- The fixture holds an authentic CDP release acknowledgement, yet cleanup deletes its cast before that awaited acknowledgement settles.
- A second viewer joins while release is awaiting and receives a different cast, or the joined cast is deleted after the acknowledgement is released.
- The joined viewer receives only state, stale identities or an unusable/empty frame; usable owner input no longer updates the real page.
- A second simultaneous viewer causes overlapping screencasts, or removing one viewer stops the remaining viewer.
- Final disconnection leaves the screencast registry, CDP listeners, retained views, pending command or leases alive.
- An already-aborted viewer creates a cast, view, polling timer or listener.
- A test failure leaves its authentic acknowledgement gate held or prevents final teardown. Browser child, local sockets, stream readers, polling and its Temp profile must close on either outcome.
- A baseline only pretends to exercise the bug. The optional `--baseline` mode changes exactly the post-release empty-cast check back to unconditional deletion, in that child process's module loader; the browser, HTTP stream and CDP acknowledgement remain real. The normal source is never edited for the baseline.

Save each condition, actual browser/version, release packet/result, cast identity/ownership, frames, native page counters and teardown observations in `result.json`. Baseline failure is expected evidence, not acceptance.
