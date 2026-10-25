# PR 303 verification

The server owns a five-second Forget deadline on the memory document and a
persistent scheduled mutation. The toast only offers Undo. Pending rows stay
hidden through navigation/reload; a failed deletion restores the row with a
persistent error. The original immediate delete endpoint remains available.

Repeat the backend lifecycle replay (temporary SQLite database, network blocked):

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/pr-303/e2e.ts
```

It writes `backend-result.json`, covering the query limit, duplicate Forget,
Undo, stale Undo, expired Undo, a database reopen, scheduler completion, injected
deletion failure, and page-line/dashboard-key guards.

The UI replay uses the repository's isolated Chrome harness and actual Brain
and Pet screens. Start an isolated dev server first:

```powershell
$env:PERRY_HOME = Join-Path $env:TEMP 'perry-pr303-ui'
$env:DASHBOARD_KEY = 'synthetic-pr303-ui'
$env:PERRY_PORT = '7399'
$env:PERRY_CREDENTIAL_KEY = '99' * 32
pnpm exec next dev -p 7399
```

In a second terminal:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/pr-303/seed-ui.ts
pnpm exec bun artifacts/pr-303/ui-e2e.ts
```

The seed only touches the fixed temporary fixture home. It creates synthetic
older memories and streaming chat records; it starts no engine. The replay
writes `ui-result.json` and screenshots, checking Forget/Undo, reload and
server expiry, a 2,000-character pet stream followed by a reset and a
500-character stream in the same mounted chat, and switching to a different
chat with existing text. T3 preview inspection timed out twice, so the
repository's browser harness was used for these UI checks.

Validation also includes `pnpm typecheck`, `pnpm exec tsc --noEmit -p convex`,
and `pnpm build`. The build reports existing whole-project tracing warnings in
`convex/pet.ts` and `server/wake.ts`.
