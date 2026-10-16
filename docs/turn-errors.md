# Stable turn failures (#244)

`lib/turn-errors.ts` is the browser/server/runner-safe contract. Persist
`errorCode?: TurnErrorCode` alongside the existing sanitized `error?: string` on
both `codexTurns` and `runs`. Values are exact, lowercase wire values:

| Code | Producer condition | Suggested action |
| --- | --- | --- |
| `offline` | No connected runner can take a turn, or recovery abandons an offline runner's turn | Start Perry on the computer and retry |
| `engine_old` | The compatibility/version check rejects the engine | Update in Settings → Engines and retry |
| `limit` | The engine rejects a turn for its plan's usage/rate limit | Wait for reset or choose another engine/model |
| `idle_timeout` | The idle watchdog stops an unresponsive engine | Retry using the retained session |
| `max_time` | The wall-clock watchdog expires | Split the request or ask the engine to take longer |
| `empty_reply` | Successful completion has no text or files, and isn't stopped, compact, checkpoint or flush | Retry |
| `restarted` | Startup recovers a running turn without a saved result | Retry; retain partial text |
| `engine_failed` | Engine failure without a more specific structured reason | Show sanitized detail and retry |

Cancellation remains `stopped`, with no failure code. A code-only failed runner
payload must produce a generic detail rather than becoming a successful turn.
An explicit code takes precedence over text. The runner may normalize a legacy
engine's limit message at its adapter boundary using the existing `LIMIT_HIT`
utility; the dashboard, Telegram, WhatsApp and routing consumers never infer a
code from prose. ACP's own stalled state explicitly produces `idle_timeout`.

Old persisted documents and old runner payloads remain valid because all new
fields are optional. Missing or unknown codes use `engine_failed` guidance;
do not migrate history by guessing from a message. `turnErrorCode` understands a
direct `errorCode` and `ConvexError.data.errorCode`, so enqueue failures survive
the internal mutation/action boundary. `turnErrorDetail` reads structured detail
without serializing stacks or arbitrary objects.

`finishTurn` sanitizes detail with the existing `hide`/`savedValues` helpers before
persistence, preserves partial text and files, and persists code on both normal
and routing-retry paths. `markFinalized` copies it to the original and joined runs.
`runs.finish` covers failures before a turn exists. The sanitized `getTurn` result
drives outgoing Telegram/WhatsApp text through `turnErrorText`. Legacy stored
detail is sanitized again when queried or delivered.

The optional `agentMessages.runId` links saved prompt/reply messages to the run.
The existing `saveMessages` API accepts this optional field; code paths that do
not represent a run need no changes. `getChatMessages` resolves failures only
for runs in the requested conversation, so pagination and repeated prompts do
not require timestamp or text matching. The chat renders `TurnError` once after
the last visible message in that run, keeps older failures after newer successes,
and supplies retry with that run's saved user-message ID. A legacy latest error
still has the existing latest-message retry fallback. Retry retains the existing
rewind semantics, including discarding messages after the chosen prompt.

The component reuses the existing alert/button primitives, announces the error,
keeps guidance visible, reveals sanitized detail in a native keyboard-operable
`details` control, wraps long text and disables retry while busy. It is imported
within chat-screen's existing client boundary; it does not introduce a second
boundary with function props.

Verification: `artifacts/turn-errors/failure-cases.md` records the failure inventory
before the E2E source. The integrated check regenerates
backend types and runs the native Node command in `artifacts/batch-1/README.md` in the combined
verification environment. The E2E sets a scratch `PERRY_HOME` and synthetic keys
before dynamic project imports, uses SQLite in memory and fake engine results,
disables scheduling, blocks external fetches and captures fake Telegram sends.
It emits `.batch-work/batch-1/244/test-home/result.json` even on failure. It does
not start the installed app, run a model or require browser downloads.
