# Finding work and chaining tasks

[Vercel Board](https://vercel.com/blog/introducing-vercel-board) treats agent work
as durable threads with task ownership, dependencies and recorded outcomes.
Perry already has threads, runner claims, progress, approvals and owner replies.
This update adds the missing ways to find work, create it in context and order
dependent tasks, using Perry's existing local backend.

## Using the Board

- **New task** is available from all work, activity, chats and project channels.
  A project channel preselects its project, including projects without work yet.
  Saving opens the new task's thread. The task's working chat inherits the project.
- **Search** matches titles, instructions, the latest update, models, computers,
  projects and nested agents. A matching agent keeps its parent visible. Search
  also applies to Activity. The URL keeps the search, sort and existing filters
  so a link or reload returns to the same view.
- **Sort** offers needs-you-first, recently updated and oldest-first ordering.
  State counts follow the current search, channel and computer filters.
- Empty search results offer **Clear search**. Empty state views offer a route
  back to all work. Activity uses the event's actual day in its date dividers.
- Schedule, goal and watch forms keep unsaved input while live work updates arrive.

## Task prerequisites

In **New task**, select tasks under **Wait for tasks**. A dependent task starts
only after all selected tasks have status `done`. It stays queued in storage and
appears under **waiting** on the Board, with links to its prerequisites and their
statuses. It has no ready-queue position and does not consume a running slot.

A failed, cancelled or deleted prerequisite keeps its dependents waiting. Inspect
the prerequisite, then use the dependent's menu to **edit prerequisites** or queue
replacement work. Removing a prerequisite explicitly
allows the task to proceed without that result. Queued tasks can also be cancelled.

Prerequisites can change only while the dependent is queued. The backend rejects
self-dependencies, cycles, missing tasks and edits that arrive after work starts.
Duplicate ids are stored once, and each task can have up to 20 prerequisites.
Dependencies are rechecked both when claiming capacity and before preparing a turn.

Completing a prerequisite wakes the existing scheduler. Successful results are
included in the dependent's prompt as reference data, with bounded excerpts from
every prerequisite. Long results name the task to inspect with `status_report`.
These results do not replace the original task brief or grant new authority.

Agents can use the same mechanism with `queue_task`:

```json
{
  "title": "Write the final comparison",
  "prompt": "Use the completed research to compare the options and save the report.",
  "dependsOn": ["<research task id>"]
}
```

`status_report` includes each task's prerequisite ids and project id. Execution,
runner ownership, cancellation, results and approvals keep their existing paths.
The schema additions are optional, so existing tasks need no data migration.

## Acceptance workflow

1. Create a task from all work and from a project with no existing work.
2. Add two prerequisites and verify the dependent stays waiting without a queue
   position, even when one prerequisite fails or is cancelled.
3. Edit the prerequisites, reject a self-cycle and an indirect cycle, then finish
   the remaining prerequisites. Confirm exactly one working turn receives their
   results and the correct project context.
4. Search by several words, clear an empty search, reload the URL, and change
   sort order. Confirm the state counts describe the filtered work.
5. Repeat search, task creation and opening a thread on a narrow screen, then
   verify the existing approvals, schedules and task steering still work.

Verification uses production Next.js, the real authenticated backend, SQLite and
runner protocol with a disposable mock runner. It does not require a live model
or third-party account. Run `pnpm run typecheck` and `pnpm run build` for source
checks, and the existing `artifacts/board-view/run.ts` for Board regression checks.
Temporary fixtures are removed after verification. Disposable server homes and
browser profiles were cleaned up; automatic approval review blocked removal of
the ignored reports and screenshots in `node_modules/.board-workflow-check`.

Verified on 24 November 2026: production build and typecheck passed, all 76
existing Board regression checks passed, and all 10 prerequisite/search workflow
journeys passed. Desktop and 390 px phone views were checked in light and dark
themes, with no browser runtime errors.
