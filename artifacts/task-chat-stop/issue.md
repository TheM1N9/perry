# Stop in a task chat restarts work and queues owner corrections

When the owner stops an active background task chat, the current reply stops but the task remains running. codex.finalizeTurn calls tasks.afterTurn without the stopped outcome, which schedules another task turn. Cancelled queued messages also invoke the continuation callback. Meanwhile brain.handleTurn forces queue policy for owner messages in task chats, and intentional stops are recorded as run errors.

Reproduced on main 7bb8d92 and PR #313's tested implementation with synthetic Runtime/SQLite fixtures. No private project chat inspection or paid calls were used for this diagnosis.

Expected: Stop holds the whole task until explicit resume; late callbacks cannot undo Stop; owner corrections steer where supported with visible queued fallback; progress and cancelled messages remain in order; resume keeps the original task/chat/session; intentional interruption displays Stopped and genuine failures keep their details.

The proposed repair and repeatable verification are prepared on `fix/task-chat-stop` in `artifacts/task-chat-stop`.
