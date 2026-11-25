# Isolated regression checks

Use pnpm for package commands. The maintained journeys in `artifacts/` exercise
Perry's real Runtime, SQLite, HTTP, runner protocol or production browser with
synthetic data. Test results belong in an output directory outside the checkout
or in CI artifacts; keep credentials, personal-store records and downloaded
reference screenshots out of commits.

Run the source checks first:

```sh
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit -p convex
pnpm typecheck
pnpm exec tsc --noEmit -p artifacts
pnpm smoke
pnpm build
```

For example, the task lifecycle journey uses native claims and finalization:

```sh
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/task-presence/run.mjs <output-dir>
```

CI runs the supported protocol journeys on Windows, macOS and Linux. Browser
journeys need Chrome and Playwright; the CI workflow shows their isolated
tooling setup and `PERRY_E2E_BROWSER`/`PERRY_E2E_PLAYWRIGHT` overrides. Fake-engine
journeys must keep their stand-in commands and empty engine homes. Local engine
status probes are not model execution. Never substitute a signed-in real engine
to make a fixture pass.

## Failure inventories

Each suite's adjacent `failure-cases.md` describes its relevant boundaries.
These additional inventories cover older checks whose original audit notes are
kept outside the public repository:

- **Library lifecycle:** same-spelled native and remote paths must remain
  distinct; immutable chat snapshots retain their original bytes; deletion,
  rescans, late uploads and opposite chat-deletion orders must not resurrect
  removed items or read/delete a remote producer's path on this server.
- **Pet storage:** denied, corrupt, stale or full browser storage must not
  prevent boot, fabricate preferences or lose recoverable input; storage
  listeners and component effects must release their resources on unmount.
- **Media uploads:** authorization, multipart/size failures, malformed uploads,
  abandoned requests and unavailable source files must leave recoverable UI
  state and must not expose another producer's local file.
- **Fullscreen capability:** API absence, refusal and native-control support
  differ from successful playback. The capability baseline does not prove
  fullscreen operation on a physical device or Safari.
- **Long-session stability:** repeated navigation, reconnects, streaming,
  server restarts and retained drafts must keep subscriptions, media resources
  and unchanged conversation DOM bounded. A fixed-duration sample does not
  establish a full-day leak-free guarantee.
- **Unattended work:** claims and grants must stay bound to one live turn;
  Stop, stale approvals, revoked authority and ambiguous delivery must not
  replay writes. Results and delivery failures must stay reviewable without
  reading a remote path or sending private server bytes.
  Delivery warnings can change while their queue timestamp stays the same:
  a second WhatsApp file failure or updated aggregate notification must not
  be cleared by an acknowledgment of the earlier warning. Current clients
  must send the displayed content revision for individual, bulk and pet
  acknowledgments; only the exact current revision and event time may clear
  it. Missing revisions keep the older client behavior. Warning state,
  message-body changes and failed/uncertain transitions must change the
  revision without storing another mutable counter; dismissal keeps history.

Every run should retain a compact result record with actual pass/fail outcomes,
the tested build where applicable, and teardown status. Synthetic protocol,
fake-engine, browser, live-provider and physical-device evidence are different;
report only the boundary actually exercised.
