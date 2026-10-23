# Task chat model inheritance

An explicit task pick such as `claude/opus` with high thinking now supplies the task chat's controls and direct owner follow-ups. Previously only scheduler-started turns received that pick; chat controls and owner replies fell back to the installation default.

The scheduler and direct replies use the same resolver. Explicit chat overrides win for later task turns. Usage-limit fallback remains in place and is recalculated without persisting a fallback as an owner choice. Reading an older task chat with no stored selections requires no migration. Existing stored chat choices remain intact because their intent cannot be reconstructed safely.

The composer sends initial selections only when creating a chat. Existing-chat model and thinking changes already have their own mutations; sending a message must not turn a displayed inherited value into a saved override.

For task chats, unset model/effort means inherit. An empty string records an intentional engine/model-default override using the existing optional string fields. No schema migration or dependency change is required.

## Repeatable verification

Run from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm run build
$env:TASK_CHAT_QA_DIR='W:\perry-qa\task-chat-model-verification'
bun artifacts/task-chat-model/e2e.ts
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/main-agent-limits/e2e.ts W:\perry-qa\main-agent-regression
```

The task test starts an isolated production server with a temporary database and synthetic runner metadata. It starts no engine process and makes no paid model calls. It verifies browser labels and native keyboard submission, queued turn selections, automatic continuation, explicit owner overrides, model defaults, usage-limit fallback, restoration, tier-only tasks and ordinary chat compatibility. Failure modes were recorded before implementation in failures.md.

The owner's installed checkout and running app are outside the test. No existing owner task, queued turn, or database is migrated or repaired by this PR.
