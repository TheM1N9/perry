# Task presence versus unfinished work

Written before isolation code. Root manually observed many weeks-old working tasks, but this lane must never access personal Perry, its database, accounts or UI. Reproduce with actual Runtime/SQLite/backend calls over loopback HTTP and synthetic metadata; no runner/engine process, scheduler, live provider or `.next` build. Review `start_task`, task schema/tick/afterTurn, Board projections, authenticated claim/check-in and existing turn-health before changing anything. No task data repair or UI edit is authorized yet.

- A tracked `start_task` row is running in the plan sense but has no execution chat. Board defaults to Working forever, whether fresh or old, even when its origin is idle or missing.
- An origin chat with a genuinely active turn is ignored for a tracked task; later unrelated origin activity must not be mistaken for proof that this particular task is executing.
- A background task remains unfinished while its latest run succeeded, failed, stopped or lost its turn. Board presents that incomplete plan as a currently running agent or silently marks the task complete/failed.
- A run still says running after its worker turn became terminal or finalized; the projection ignores the terminal worker.
- A finalized earlier attempt shares a run with an authoritative `retryOf` replacement. Reading the first attempt hides a queued replacement or falsely treats an authenticated running replacement as terminal.
- A durably queued/preparing follow-up, reset wait, pending owner question or pause is mislabeled stale/failed, or confused with currently executing work.
- An old task with a freshly claimed worker/per-turn heartbeat is falsely flagged based on task age, quiet output or a long tool call.
- Machine heartbeats unrelated to a dead modern per-turn worker prolong it; unresponsive/revoked/missing runner state is ignored. A valid recovered worker heartbeat fails to clear the warning.
- A stopped/completed/failed task's explicit terminal state or a blocked task's owner question is overwritten by incidental execution metadata.
- A new owner-visible display state offers an unusable steering composer, loses access to source chat/history or implies permission to retry external side effects. Preserve task status/plan/result/history and use existing review/open-chat/cancel affordances until recovery semantics are agreed.
- Repeated Board reads or server restart mutate legacy task data, enqueue new work or retain an unbounded presence cache/timer.
- A newer steering receipt run hides the older genuinely executing turn; the Board mistakes missing receipt execution for no worker.
- A tracked origin link attaches unrelated origin agents/questions or infers that a later origin turn executes this tracked plan. Review links must stay separate from dedicated execution identity.
- Reset retry, stopping and final delivery incorrectly leave the steering composer enabled, or active/queued recovery loses valid owner updates.
- The fixture talks to an account/model, runs cron/actions, leaves a local HTTP listener/SQLite/home or reports successful UI verification from a backend-only projection proof.
- A menu assertion reads an immediate visibility snapshot before its portal is positioned. Wait for the cancel action to become visible, then verify Escape closes it before continuing the journey; missing or stuck menus must still fail within a bounded deadline.

Before the production browser fixture: use one isolated Next server/home/Chrome on the root-coordinated build, fake runner metadata with actual authenticated enqueue/claim but no runner process, no live account/model. Mutations create plans/chats and SQLite only supplies bounded synthetic turn/delivery preconditions. Verify Tracked/source link stays separate from execution and has no steering; Not running keeps open-chat/cancel/review; a claimed worker retains Working/steering; a real owner update remains on that same active worker despite a new receipt run; terminal delivery says Finishing and removes steering; raw plans/statuses survive; no pulse for nonexecuting rows. Native screenshots and normal harness teardown are required. Do not touch personal Perry or rebuild shared `.next` from this lane.

The proof will preserve raw task/run/turn snapshots and Board output, authenticated protocol outcomes, exact commands and normal teardown in a repeatable report. Source findings and any proposed projection repair go to root before edits.

Task-completion integration inventory (before maintained journey additions): exact authenticated origin-run finalization may fail to close a confirmed plan, or close an unrelated/legacy plan; saved candidates may become urgent questions, replay the full job, unblock prerequisites, or lose the useful result; versionless/changed owner actions and late old finish callbacks may overwrite newer work; Stop/error may falsely complete a plan; attachment-only success may generate again. Extend this actual Runtime journey with native claim/finish/finalize, receipt actions, stop/error and registered media, preserving raw unupdated steps and zero external IO. The detailed original inventory is artifacts/task-completion/failure-cases.md.

Task-admission failure inventory, before the native scheduler replay:

- Two queued tasks are marked running, then their separately scheduled admission mutations throw before making a turn. They must fail visibly and release both slots rather than leave every later task queued forever.
- Failure after partial thread/chat/run/turn creation or while inserting the preparation schedule must roll back those admission writes together. A failed task must retain its original brief, plan and earlier saved work, and report its outcome once without copying a raw exception into owner-visible text.
- Work committed before this admission attempt is not a failed startup: an existing queued/running/finalizing turn or pending accepted steering must remain owned and must not be retried or failed by this attempt.
- Successful admission must still create exactly one preparing turn and one preparation schedule. Repeated work callbacks must neither duplicate that turn nor report a startup failure.
- Cancelled tasks, pause and unmet prerequisites must keep their existing hold semantics. A caught admission exception must not turn those holds into completion or run a model/notification action.
- The bounded scheduler replay must stop before handoff or preparation actions execute, clear its watchdog/listener and close its isolated SQLite runtime. No live runner, account, paid model or owner data may be used.
