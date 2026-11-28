# Board Kanban native verification

The maintained replay uses a production Next server, real Runtime/SQLite records, authenticated native backend mutations and an isolated Chrome profile. It never starts an engine or uses the owner's Perry home. The installation is paused, and the existing connector preload blocks external network calls.

After a production build:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/board-kanban/run.ts node_modules/.cache/board-kanban-review
```

Set `PERRY_E2E_BROWSER` to Chrome on systems without the default Windows installation. Set `PERRY_E2E_PLAYWRIGHT` to an installed Playwright `index.mjs` if the Codex runtime driver is unavailable.

`result.json` records each assertion, the build ID and synthetic fixture IDs. Screenshots cover desktop columns, empty search, decisions, native child questions and approvals, informational updates, a live completion, activity and phone detail in both themes. UI-driven checks exercise each filter, sorting, clearing, keyboard focus and both layouts. Working and completed parents with child decisions appear in Needs you, retain their own execution badges, and keep actionable children nested. Mixed queued tasks/chats keep a consistent order in Kanban and List; provider-agent follow-up runs retain their started, commentary and finished Activity events.

The harness ends Chrome and the production server and deletes the disposable home/profile on success or failure. Review these outputs, then remove that run's output directory; keep the maintained fixture and failure inventory. Use Node for this replay: Bun can stall while Playwright attaches to Chrome's browser DevTools socket.
