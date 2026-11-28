# Chat message order verification

Verified on 28 November 2026 with production build `dd042f6a-6f81-4fc8-80c1-605844671d0a`.

The browser replay passed all 14 checks. It used production Next.js pages and real Runtime/SQLite persistence in a fresh temporary Perry home. The scheduler stayed stopped; an authenticated fake runner claimed turns, streamed output, acknowledged updates and finalized replies through production handlers. Browser interception delayed or rejected only synthetic message transport. No provider started, no external message was sent, and no owner chat or files were used.

| State | Verified result |
| --- | --- |
| Initial request, preparing and streaming | Request precedes the single live reply. |
| Follow-up while a reply runs | Optimistic, received, pending and applied message all follow the existing live reply. The live DOM node and streamed text survive insertion. |
| Receipt before engine acknowledgment | Delivery metadata distinguishes waiting from applied internally. The bubble is shown optimistically, without transport-status footers. |
| Multiple follow-ups | Messages retain send order. Explicit Queue stays in Up next. |
| Hidden worker result | Hidden preparation, pending/applied steering and refused queue fallback never become owner bubbles, including after reload. |
| Rejected send | Draft returns to the composer, error is visible, and no phantom bubble remains. |
| Reading earlier history | Incoming messages and stream growth preserve the reader's history anchor within two pixels; Jump to latest remains available. |
| Chat navigation | Pending messages remain scoped to their conversation; returning restores ordering. |
| Completion | All owner inputs precede the newly completed answer and survive reload exactly once. |
| Refused update | Message moves into Up next without an applied label. |
| Stop | Unacknowledged input is retained without a stale Sending or Added state. |
| Repeated equal messages | Two distinct applied messages become two saved messages after reload. |
| Target finishes before preparation | Follow-up prepares a separate next reply; it does not claim to join the completed target. |

There were no unhandled browser or transport-harness errors. Native cleanup confirmed removal of the isolated home, profile and processes. Desktop and 390px mobile screenshots show the real dark dashboard; the settled mobile queue was captured only after its Send now control appeared. The document width fit the mobile viewport.

## Repeat the browser protocol

Use a disposable installation and synthetic conversations. Build with `pnpm build`. Reuse the existing native setup in `artifacts/engine-acp/harness.ts`; initialize Runtime with its HTTP registry and scheduler stopped, plus a signed-in synthetic runner. Keep owner credentials and provider binaries out of the fixture.

1. Open a synthetic chat and submit through the current contenteditable `#composer`. Verify the initial bubble is before the live reply. Fill its durable reservation with `codex:enqueueTurn`, then report claim/start/stream through the authenticated runner handlers.
2. Submit another request using Send into the reply. Delay admission and verify a full-opacity bubble immediately below the stream, without a transport-status footer. Admit the real mutation, prepare its reservation, then use `codex:ackSteer` with `applied: true`. Assert one bubble, correct order and identical live-reply DOM node throughout.
3. Repeat with multiple messages, equal text and explicit Queue. Inspect the settled Up next controls. Reload while active, switch to another synthetic chat and return. At 390px verify horizontal fit and capture the settled page.
4. Submit a unique hidden marker through hidden preparation, hidden steering and refused fallback. Query `dashboard:getChatMessages` and inspect the DOM at each stage; the marker must never appear.
5. Reject a synthetic send before backend admission. Verify draft recovery and absence of a user bubble. Scroll to older history, send another backend update and stream more content; compare the same visible anchor's top position.
6. Finish and finalize through production handlers, then reload. Verify each input and the completed answer exactly once. In separate chats, refuse a steer, stop before acknowledgment, and complete a target while its follow-up is still preparing. Confirm the state distinctions in the table.

The temporary browser replay and preload were removed after verification. Synthetic PNGs, the prewritten failure inventory and the machine-readable result were delivered separately. Existing project tests were preserved.

## Maintained regression checks

The existing worker webhook replay passed 19 cases, including hidden reservation persistence/restart, pending/applied steering and refused fallback. The existing message lifecycle replay passed 55 cases covering admission, FIFO preparation, steering, Stop, cancellation, recovery and attachments. These checks exercise real handlers and isolated SQLite rather than provider responses.

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/worker-webhook/run.mjs node_modules/.cache/worker-message-privacy
$env:PERRY_E2E_OUTPUT = 'node_modules/.cache/message-lifecycle-review'
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/message-lifecycle/run.ts
Remove-Item Env:PERRY_E2E_OUTPUT
```

The delayed duplicate-query experiment was not counted: ordinary same-screen sends wait for mutation query refresh before clearing busy. The final browser replay instead verified equal sequential sends through pending, applied and persisted history. Model-specific wording and real provider latency were outside this replay's scope.

## Optimistic feedback follow-up

The revised interface was verified on production build `1211af7a-ba10-4896-9a67-1b1a440e1adc`. All eight native browser checks passed in a fresh isolated Runtime/SQLite installation with a stopped scheduler and authenticated fake runner. No owner data, provider work or external messages were involved.

- Before backend admission, a normal message appeared immediately at full opacity with its reply working, without Sending, Saving or receipt footers.
- An active follow-up stayed below the same streaming DOM node through admission and model acknowledgment. Explicit Queue appeared immediately in Up next and then gained its real queue controls.
- A rejected send removed the optimistic bubble and restored the draft with a visible error. Equal messages stayed distinct through finalization and reload.
- Settings identity edits and note titles stayed immediately editable while their real save requests were held. Routine Saving/Saved labels stayed absent. Accepted edits survived reload; rejected edits retained the input, showed an error with Try again, and persisted after retry.
- The 390px chat fitted the viewport. Browser and transport-harness error lists were empty. Native cleanup confirmed removal of the temporary home, browser profile and processes.

Synthetic desktop/mobile chat, identity and note screenshots, the failure inventory and machine-readable result were delivered separately. The protocol uses real dashboard mutations; interception only delays or rejects synthetic transport and never replaces query data. Existing project tests were preserved.
