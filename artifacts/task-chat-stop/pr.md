Stopping a background task chat interrupted its current reply but left the task running. Finalization then started another turn, and owner corrections were always queued. Intentional stops also appeared as failures.

Stop now holds the same task until the owner sends a new message or answers on the Work page. A durable Stop version rejects callbacks and prepared messages from before that Stop, including after an immediate resume. Owner chat updates use existing native steering and ordered fallback; automatic prompts remain queued. Cancelled messages and partial progress remain visible in admission order. Resume retains the same task, chat and engine session. Activity distinguishes Stopped from genuine provider failures.

Validation: production build and TypeScript passed, with 178 checks: 25 Runtime/SQLite lifecycle, 18 production backend/browser, 62 existing native-steering, 37 usage-limit recovery and 36 task model-inheritance checks. All fixtures used synthetic data without paid model calls or a production runner. Repeatable scripts, failure inventory and result artifacts are in `artifacts/task-chat-stop`.

Existing histories are not migrated. Native steering still depends on engine support; unsupported delivery uses the existing queue. The installed Perry and owner database are unchanged. Installation and restart remain with the owner.
