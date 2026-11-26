# WhatsApp progress replay

Write these cases before the implementation. Exercise the registered handlers,
native SQLite and runner trace collector in a disposable Perry home. The scheduler
stays stopped, no engine/model is started, and no real phone or provider is used.

- A matching final fallback can arrive after progress is reserved but before its send outcome is recorded. It must wait on that outcome rather than dispatch twice; confirmed success settles one final record, known failure preserves final delivery, and an ambiguous send remains unconfirmed rather than being blindly replayed.

- Partial assistant text, reasoning, tool output, final answers and child-agent
  messages must not be published as progress. Only explicit completed progress
  events may enter the outbox.
- Repeated reports, late deltas, duplicate provider item IDs and the same text
  under a new item ID must not send duplicates, including after SQLite restart.
- Rapid progress must coalesce to one pending message; after a send, another
  update must respect the durable interval and per-turn limit.
- Empty text, NO_REPLY and the private memory footer must not be sent. Long text
  must remain bounded and valid Unicode. Existing saved secrets must be hidden.
  Trailing blank lines must not reveal the footer. Bold, italic and fenced code
  must be formatted once and retain that formatting at send reservation.
- A newly saved secret after enqueue must be removed at reservation, and the
  transport must use the reservation's current sanitized text.
- Only the linked owner's WhatsApp chat is eligible. Guests, other channels,
  background preparation, flush/checkpoint/compact turns, revoked ownership,
  unlinked WhatsApp, paused or stopped turns must produce no live progress.
- A valid queued update can become invalid before reservation. Stop, Pause,
  revocation, turn completion or final reply queueing must prevent its send.
- Progress must use a distinct association from final-delivery turnId. Sending
  or failing progress must never finalize the reply or create final warnings.
- Ambiguous progress delivery must not be replayed after recovery. Progress
  failures must not obstruct the eventual final reply.
- Final queueing removes pending updates and remains idempotent. Retry/restart
  cannot publish stale progress after the final answer.
- When the engine ends successfully with its last commentary as the fallback
  answer, a progress text already sent must not be sent again verbatim as the
  final reply. The existing delivered row must retain final-turn association and
  final delivery timestamps. A distinct final reply must still be queued; an
  unsent matching progress update must become only one normal final send.
- Fixture failures must still leave a repeatable JSON result and close runtime,
  SQLite and disposable data. Existing owner data must never be accessed.

Run with:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/whatsapp-progress/run.mjs "$env:TEMP/perry-whatsapp-progress"
```
