# Phone message grouping and silence

Perry groups rapid owner messages on WhatsApp and Telegram before starting a turn. After 1.5 seconds without another message, it joins their text in arrival order and submits one request. A continuous stream flushes after at most 7.5 seconds. A batch also flushes at 20 messages or 32,000 characters.

Attachments flush immediately, carrying the preceding buffered text and the attachment's caption into the same turn. Slash commands bypass the delay. Other commands flush preceding text first; `/stop` cancels the pending batch in that chat and `/pause` cancels all pending batches. Messages received while paused get the existing paused notice and cannot resume later as work. Pairing, approvals, and task decisions keep their existing immediate handling.

`convex/phoneInbox.ts` stores one buffer per conversation in SQLite and replaces its durable scheduled flush when more text arrives. Stale callbacks cannot consume a newer revision. The flush reserves a normal turn before asynchronous preparation, preserving queue order and the existing live steering behavior. Completed and cancelled batches delete their rows and timers. Pending batches survive a server restart.

Messages in one batch appear as one combined owner message in chat history. Separate batches can still queue separately when the engine cannot accept live input, or when the earlier reply has ended. A long answer can still be split to satisfy the messaging app's length limits.

Reactions are optional acknowledgements. In an owner chat, an exact final `NO_REPLY` intentionally ends the turn without text, even without a successful reaction. The existing delivery flag `reactionOnly` records this outcome for compatibility. Empty output, stopped turns, errors, and files retain their existing handling. Jobs, tasks, checkpoints, resets, and compaction cannot use this shortcut to skip required results. Scheduled notifications retain their existing controls.

Verification on 2026-11-24 passed the production build, typecheck, 28 phone E2E checks, and all 26 existing task handoff checks. The production server and real runner used a stand-in ACP agent, Telegram Bot API, and WhatsApp driver. Coverage included transport deduplication, concurrent channel bursts, ordered delivery, stale timers, explicit silence, genuine empty failures, both attachment paths, stop/pause, restart recovery, live steering, and batch limits. Background results and decisions still reached Perry once.

The isolated Perry data directories were removed by the existing harness after each run. Automatic approval review rejected deletion of `artifacts/.phone-bursts-e2e` with “blocked by policy,” so the temporary harness and reviewed result files remain there. Existing project tests were preserved.
