# Quiet optimistic saves

Ordinary dashboard edits appear immediately and persist in the background. Routine Saving/Saved narration is removed from the shared status used by Brain notes, assistant identity, project instructions and contact briefs, plus meeting notes and interactive drafts. Chat admission and receipt footers are quiet too; queue placement still distinguishes a separate next request.

The existing draft controllers still serialize persistence, retain newer typing, protect unsaved work on navigation and detect revision conflicts. Failed saves, recovered drafts, conflict choices and retry controls remain visible. Explicit workflow progress and useful completion feedback remain available.

To-do additions clear the capture field immediately and insert a provisional row. Typing stays available while admission finishes. Provisional row controls cannot send a fabricated ID to the server. Completion, removal, repeat changes and undo also update locally and roll back if rejected. Failed captures retain their words with separate retry and dismissal controls, including when newer text is already in the field.

The native client replays overlapping optimistic changes as a scoped batch. A failed operation removes only its own change; an earlier response cannot erase a later pending change. Server echoes do not duplicate provisional additions. Unrelated queries remain live; external edits to the same optimistic query become visible when its batch settles. Session invalidation and close discard the batch. See `verification-optimistic-client.md` for the transport replay and its loaded-query contract.

The production build `1211af7a-ba10-4896-9a67-1b1a440e1adc` passed TypeScript and compilation. The native client transport replay passed eight cases. The existing interactive-answer production browser/HTTP replay passed 52 checks, including local recalculation, autosave, rejected saves and retry, revision conflicts, newer typing during reset/undo, export, restart/reconnect and cleanup. The replay used synthetic account endpoints and runner reports; it made no real account/model calls. Its temporary home was removed. Connection-refused console entries occurred during the deliberate server restart; no uncaught page errors were reported.

A final production build, `69cb3378-26b4-465a-a7bc-039c9c6aa169`, also passed after a display-only adjustment kept the interactive draft Actions menu aligned right when the routine status text is absent. The functional replays above and the quiet chat/to-do browser replays used the preceding build.

The maintained notes, projects, field-autosave, to-do and interactive-answer journeys were updated to verify persisted data and quiet presentation instead of waiting for a Saving/Saved label. Existing tests were preserved. The targeted quiet chat/settings/notes and to-do browser results are documented alongside their respective replay protocols.

Repeat the interactive regression with a production build, installed Playwright and Chrome:

```powershell
$env:PERRY_PLAYWRIGHT_MODULE = 'C:/path/to/playwright/index.mjs'
$env:PERRY_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
pnpm exec node artifacts/interactive-answers/run.mjs <output-directory>
Remove-Item Env:PERRY_PLAYWRIGHT_MODULE
Remove-Item Env:PERRY_CHROME
```
