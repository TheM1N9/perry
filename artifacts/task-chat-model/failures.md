# Failure inventory before implementation and isolated verification

- An explicit Claude/opus/high task initially executes correctly but its chat shows Codex/default effort.
- A direct owner follow-up uses installation defaults instead of task selection, including when the task has finished or is blocked.
- Sending the composer persists a derived model/engine as an intentional owner choice and masks subsequent task routing.
- Automatic continuation ignores a deliberate owner model/effort override made in the task chat.
- Model-default and thinking-default overrides accidentally inherit the original task model/effort.
- An effort-only override loses the task engine; a model switch accidentally resets or misapplies the thinking level.
- Missing legacy chat settings require migration or cause a write just from reading the chat.
- Genuine settings in legacy task chats are overwritten by attempted bug cleanup.
- Usage-limit movement stops working, persists a fallback as an owner override or is displayed inconsistently.
- A tier-only task follows the installation default with the wrong tier/model/effort.
- Missing task records cause query failures instead of normal conversation fallback.
- Normal chats, guest chats or scheduled jobs change behavior unintentionally.
- Verification reaches the owner database, starts a model CLI or makes paid model calls.
- Production build, TypeScript or browser hydration fails even though backend checks pass.

Use an isolated production server and synthetic runner metadata, with no engine process. Assert queued turn selections, task routes, browser controls and owner overrides; retain result JSON and a browser screenshot. Keep the owner's running installation unchanged.
