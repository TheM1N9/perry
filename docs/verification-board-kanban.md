# Board Kanban

The Board opens in Kanban, with List, Updates and Activity available in the same header. Source, project, computer, status and search filters share the existing URL state, including direct links to work details.

Cards show a readable title, the actual question or current step, the source and computer, and a specific next action. The six columns use the existing backend states. Needs you contains questions and approvals; saved plans, dependency waits and results awaiting review retain their own Waiting labels. Stopped and cancelled work remain distinguishable from successful results.

The duplicate Board sidebar is replaced by source and project filters. Desktop columns scroll within the workspace; phone layouts stack vertically. Each column initially mounts at most ten cards and expands independently. Child agents remain nested under their parent. A matching child keeps its parent discoverable without changing the parent's own state, and outstanding child requests are prioritized ahead of older finished work.

Details use the existing Sheet primitive for keyboard focus containment and Escape dismissal. Closing returns focus to the source card when it is still present, or to Board search if a live transition removed it from the current filter.

## Reference review

The references informed hierarchy and navigation; Perry keeps its own components, tokens and live execution states.

- [Productboard status roadmap](https://mobbin.com/screens/ce23150a-ecf0-4493-ac90-73d049b4cfed?utm_source=codex&utm_medium=ai-assistant&utm_source_platform=mcp): clear column labels and separated card summaries.
- [folk pipeline](https://mobbin.com/screens/a4f1de83-43c6-481e-ae5e-3dfa7c2cf3d1?utm_source=codex&utm_medium=ai-assistant&utm_source_platform=mcp): primary card identity with secondary metadata and contextual details. This is a CRM reference, used for structure.
- [incident.io incident board](https://mobbin.com/screens/010acea1-5afb-4a98-b71e-157bcb31edcb?utm_source=codex&utm_medium=ai-assistant&utm_source_platform=mcp): operational states and readable incident summaries. This is an incident-management reference.

## Repeatable verification

`artifacts/board-kanban/failure-cases.md` records failure modes before the isolated browser replay. `artifacts/board-kanban/run.ts` uses real Runtime/SQLite records, native HTTP mutations, a production Next server and a disposable Chrome profile. It creates no provider or integration work and does not use the owner's Perry installation.

```powershell
pnpm build
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/board-kanban/run.ts node_modules/.cache/board-kanban-review
```

The replay writes a JSON assertion record and synthetic desktop, phone and dark-mode screenshots. Its disposable server, database and Chrome profile are cleaned by the harness. Run outputs are inspected and removed after verification; maintained replay sources remain in the repository.

The existing native browser regressions were adapted to select List explicitly and to use the new status filter, without removing their behavioral checks. Their Node runs passed 42 assertions: owner controls (31), scoped search recovery (5), and task presence (6). These cover failed saves and retained drafts, prerequisite cycles, stale edits, cancellation, source links and actual worker presence. All three reported no browser exceptions and removed their disposable Perry homes.

The question-form check in the Kanban replay verifies the real native request, choices and details. It does not submit an answer while the synthetic installation is paused; it does not claim provider delivery or a live external conversation.

## Verified result

The final settled production replay passed all 13 journeys on build `50959010-17f7-43ff-82e3-e90d2539a9fb`:

- All six source states, explicit next actions, and no duplicate agent cards.
- Independent ten-card column expansion, fixed desktop card widths, internal scrolling and oldest-ready-first queue order.
- Native source/project, computer, status and sort controls, clearing and layout switches.
- Keyboard opening, 18 Tab cycles inside details, Escape/Close and source-card focus restoration.
- Child search, native question controls, and a completed parent retaining its child's approval ahead of pagination.
- Questions and approvals separated from informational updates and passive waits.
- Native task transitions moving one card without a page reload.
- List, Activity and existing status/thread deep links.
- 390px and 320px layouts without page-wide overflow, usable full-width details and dark mode.
- Search focus recovery when another action resolves and removes the originating card.
- No uncaught browser errors and no engine process.

The final replay reported `passed: true`, `tempHomeRemoved: true` and an empty browser-error list. Screenshots were inspected after finite UI transitions settled. The earlier browser replay exposed filter menus that stayed open; native `closeOnClick` now closes these single-choice menus. It also exposed squeezed columns and misleading queue order, both corrected before this final run. Node is required for the replay because Bun stalled at Playwright's Chrome websocket handshake in this environment.

`pnpm build`, the application/Convex TypeScript checks and `pnpm exec tsc --noEmit -p artifacts` passed. Existing backend history limits remain unchanged; this change does not introduce unrestricted historical queries or pretend that execution status can be edited by dragging a card.
