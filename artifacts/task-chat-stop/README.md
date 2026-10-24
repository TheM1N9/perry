# Background task Stop and live corrections

Based on main `62dd856f1215f54d60e27b2c00061e2f91e07056`. The owner approved the repair plan on 24 October 2026. Work stayed in an isolated checkout; installed source, dashboard, runner and owner database were not changed.

Stop holds the task using its existing blocked/resume state. A monotonically increasing Stop version fences asynchronous preparation, queue admission, claims and task continuation, including after explicit resume. Owner messages use the existing steering queue and fallback; scheduled task prompts always queue. New owner messages resume the same task/chat/session. Intentional stops have a dedicated run status and neutral Activity label. Cancelled queued messages finalize after preceding work so history stays in order.

## Verification

Production build and TypeScript passed, with all 37 pages generated. The build emitted the existing dynamic-filesystem tracing warnings in `convex/pet.ts` and `server/wake.ts`.

| Workflow | Passing checks | Evidence |
| --- | ---: | --- |
| Real Runtime/SQLite Stop, races, queue, resume, recovery | 25 | protocol-result.json |
| Production backend/browser, desktop/mobile | 18 | app-result.json; stopped-chat.png; stopped-mobile.png |
| Existing native steering adapter and acknowledgement retries | 62 | steering-result.json |
| Existing main-agent usage-limit/reset recovery | 37 | recovery-result.json |
| Existing task model inheritance backend/browser | 36 | model-result.json |
| Total | 178 | All suites passed |

The protocol harness forbids network traffic and drives callbacks against synthetic SQLite data. Browser runs use separate temporary homes, spare ports and synthetic runner metadata; no runner/model process is launched. Native adapter checks use a fake engine. No paid model calls occurred. Final browser screenshots were inspected for ordering, stopped labels and mobile fit.

Repeat from the repository root with pnpm:

```powershell
pnpm install --frozen-lockfile
pnpm run build
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/task-chat-stop/protocol.ts W:/perry-qa/task-stop-repeat/protocol
$env:TASK_STOP_QA_DIR='W:/perry-qa/task-stop-repeat/app'
pnpm exec bun artifacts/task-chat-stop/app.ts
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/task-steering/run.ts
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/main-agent-limits/e2e.ts W:/perry-qa/task-stop-repeat/recovery
$env:TASK_CHAT_QA_DIR='W:/perry-qa/task-stop-repeat/model'
pnpm exec bun artifacts/task-chat-model/e2e.ts
```

The production build must remain frozen while browser fixtures run. Raw evidence and build logs are under `W:/perry-qa/task-stop-20261024`. The existing native-steering suite caught an overstrict guard that treated a task's own running turn as an unread update when the caller omitted turnId. The guard was corrected and all 62 checks passed. Screenshot review caught reversed stopped history, which was repaired and checked in both finalization orders and the final browser run.

## Limits

Native steering depends on engine support; its existing queued fallback remains available. Cancelled messages stay visible and are not replayed on resume. Existing historical failures are not migrated. Final evidence verifies backend, adapter and browser behavior using fake engines, rather than real model-provider execution. Running Perry installation and restart remain with the owner.
