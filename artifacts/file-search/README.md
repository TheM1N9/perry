# Native sidebar Files search replay

This replay seeds a fresh SQLite home, runs Perry's real workspace queries and a production Next.js server, and drives the Files panel with Chrome. It uses synthetic documents and starts no model turn or live account integration.

Build the checkout first, then run:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/file-search/run.mjs node_modules/.cache/file-search/current
```

The replay seeds more than 130 files, including matches beyond the first 50 memberships, hidden and working files, a shared project chat, an unrelated chat, and a contact source. It checks scoped matching and pagination through the authenticated production API. The UI journey types search terms, opens a file preview, returns to matching results, clears with the button and Escape, checks Enter, changes chat/project scope, and checks a 390 × 844 viewport.

The output contains incremental `result.json`, a bounded synthetic server log, and desktop and phone screenshots. The process exits nonzero on failure. Temporary homes and owned Chrome/server processes are removed in `finally`. Inspect and remove the disposable report folder after a run; keep the maintained replay and failure inventory.

Windows with installed Chrome is the verified platform. `PERRY_E2E_BROWSER` selects another Chrome executable. The phone check uses Chrome device metrics and does not establish physical mobile-device keyboard behavior.
