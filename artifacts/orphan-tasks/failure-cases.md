# Orphan task recovery

Failure cases recorded before the implementation and replay:

- Resuming a blocked task with a deleted conversation marks it queued or running without executable work.
- Cancelling an orphan calls a conversation-ID validator and rolls back the cancellation.
- Deleting a task's idle chat leaves an active or blocked task behind.
- Recovery never notices an old running task whose conversation is missing.
- Missing chats occupy all background-task slots and prevent healthy tasks from starting.
- A healthy blocked task cannot resume, or a new task awaiting chat creation is incorrectly failed.
- Running a scheduled work callback after deletion creates a replacement chat or throws indefinitely.
- Steering an orphan reports success without a delivery.
- Repeated recovery changes completed tasks or creates duplicate recovery effects.
- Cancellation fails when both the task chat and the origin chat have been deleted.

Use the actual SQLite Runtime and registered backend functions with synthetic
conversations. Keep the scheduler stopped and external network traffic disabled.
Persist each scenario in `result.json`; no engine or owner data is used.
