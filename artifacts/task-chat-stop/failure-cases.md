# Failure inventory, before implementation and new test code

Synthetic fixtures only; no owner database, access-denied chat, live runner or paid API calls.

1. Dashboard Stop or /stop interrupts only a turn and automatic work restarts.
2. Stop between turns misses a scheduled work callback.
3. Stop during asynchronous task preparation, routing or owner-message preparation admits stale work.
4. Stop then immediate resume permits callbacks from the earlier execution to start or fail the resumed task.
5. Queued owner turns, pending steering fallback or repeated finalization restart a stopped task or consume extra turns.
6. The runner finishes after Stop without sending stopped=true, or sends an interruption error, and the task restarts.
7. A genuine provider error is hidden by the new Stopped presentation.
8. Global Pause and later global Resume restart a held task without an explicit task resume.
9. Usage-limit recovery, reset timers or stale routing callbacks bypass Stop.
10. An owner follow-up is forced to queue despite a matching active engine; an automatic prompt steers instead of waiting.
11. Unsupported steering loses, duplicates or reorders an update instead of using the existing queue fallback.
12. Model changes, attachments, access settings or outside-read provenance disappear from a steered update.
13. Stop cancels queued messages without preserving their text and visible stopped outcome.
14. Resume starts a new task/chat/session, discards completed work, or replays cancelled messages automatically.
15. Normal completion fails to continue a running task; task completion races an accepted owner update.
16. Ordinary owner chats, deliberate model overrides, task cancellation and maintenance/compaction regress.
17. Activity and chat failure indicators label intentional interruption Failed; genuine failures cease to display details.
18. A legacy task/turn without a version cannot continue normally, or an old scheduled callback survives the first Stop.
19. A cancelled queued message finalizes before its interrupted predecessor and reverses their visible history. Found during screenshot review; recorded before its repair and ordering assertion.

Verification will use real Runtime/SQLite lifecycle functions and isolated production dashboard/browser calls. Network/model execution is forbidden in the protocol harness. Browser fixtures have synthetic runner metadata without a runner process. Every run writes results.
