# Batch 2 integrated verification

Recorded before coordinator E2E fixture code.

Isolation failures: inherited real environment/keys, dotenv reads, accidental normal
bootstrap, scheduler or engines starting, remote API/model/browser downloads,
fixture paths escaping batch scratch, excessive profile/screenshot storage, or
stopping a process other than this fixture. Reuse batch1 guards, a stopped Runtime
singleton, synthetic credentials, loopback only, and a fresh batch2 home.

Integration failures: queue admission bypass through outbox/steer/retry/compact;
claim/removal race cancelling active work; unrelated account auth state changed;
stream offsets/retries losing text; late terminal writes; secret split across
chunks surviving vault save; metadata invalidation on every stream flush; Notes
partition missing ordinary insert/delete/kind transition/import invalidation;
legacy clients/events failing conservatively; pet/terminal stream consumers lost.

UI failures: 200 rows not actually loaded; minified component names or profiling
disabled giving misleading counts; hydration/pagination counted as typing;
draft/caret/Shift+Enter re-rendering history; clock ticks reaching the screen;
stream leaf not updating or dragging an older reader down; changed row hidden by
memo; stale action/chat closures; failed send losing draft; queue removal target
wrong or capacity not freed; reconnect incorrectly accepting another account.

Run existing backend E2Es against integrated files. Use one production profiling
build and one disposable server. Record actual counts and explicit unrun paths;
do not treat syntax/typechecking as functional UI verification.
