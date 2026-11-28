# Optimistic to-do interactions

The dashboard and desktop pet share the same to-do entry and rows. Add now clears the submitted entry immediately, inserts a provisional row and lets the owner type the next draft while admission runs. It no longer displays a Saving label. The Add action stays guarded against duplicate submission while that request is pending.

Complete, remove, repeat selection and removal Undo update the subscribed board through the existing `withOptimisticUpdate` API. The native client keeps overlapping changes together, so an earlier response cannot erase a later optimistic action. Recurrence and streak calculations remain server-owned.

Provisional ids are created once per action and cannot be used for completion, removal or repeat controls. Successful native query refresh replaces the provisional row with its real record. If Add starts before the board has loaded, that operation uses the real initial snapshot instead of appending a provisional duplicate later. Failed writes roll back the board; failed additions restore into an empty entry and preserve newer typing. Each failed capture remains visible with its own Retry and Dismiss actions, so repeated failures cannot silently replace one another. Repeat errors are shown instead of swallowed.

## Repeat native verification

Build the production dashboard first, then run the maintained browser replay against a fresh synthetic installation:

```powershell
pnpm build
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/todo-feedback/run.ts node_modules/.cache/optimistic-todos
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/todo-feedback/run.ts node_modules/.cache/optimistic-todos-recovery --overlap-only
```

The prewritten failure inventory is `artifacts/todo-feedback/failure-cases.md`. The replay uses real production pages, Runtime/SQLite and actual mutations; a browser transport gate delays or rejects only synthetic requests. It verifies immediate rows and completion, held acknowledgments, newer typing, scoped overlapping mutations, rollback, literal/date/repeat parsing, Undo, narrow layouts and the pet's existing callbacks. Each run ends in `result.json`, screenshots and native fixture cleanup. No provider or owner data is used.

## Verified results

Verified on 28 November 2026 against production build `1211af7a-ba10-4896-9a67-1b1a440e1adc`:

- The full maintained replay passed 24 of 24 checks.
- The failed-capture recovery replay passed both checks, including preserving newer typing and explicit dismissal without erasing the other draft.
- Both native fixture homes, profiles and processes were cleaned by the harness. There were no browser runtime errors or provider turns.
- Captured mutation requests contained zero provisional `pending-todo:` ids.
- The 390px dashboard and 404px pet fit their viewports. The pet's existing addition/completion callbacks still fire once, and failed writes never trigger success callbacks.

Synthetic screenshots and machine-readable full/recovery results were delivered separately. Existing project tests were updated and preserved; the unused task-specific inventory file was removed after its cases were incorporated into the maintained failure inventory.
