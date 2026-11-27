# Phone clarification failure inventory

This inventory precedes the fixture and production changes. The replay uses the native Runtime, SQLite schema, authenticated runner endpoints, WhatsApp intake/outbox and Telegram update parser/intake. It sends no real messages and starts no paid model.

- A native question is saved but never queued to the originating owner phone.
- A retried native request produces duplicate question batches or phone prompts.
- A question intended for a dashboard, contact, guest, preparation, stopped or finished turn leaks to a phone.
- A disconnected/unpaired, changed-owner or paused installation sends a previously queued question.
- Ordinary text or a bare number is intercepted as an answer to an unrelated question or approval.
- A quoted reply selects the wrong batch, question, recipient or channel.
- A command code is missing, malformed, stale or attached to the wrong owner/channel.
- A Telegram reply preserves the author but loses the replied-to message ID.
- Numeric options are passed as numbers instead of the option labels the engine expects.
- Multiple selection is split incorrectly; invalid or excessive choices prematurely complete the question.
- Free text, punctuation, multiline text or a number on a question without options is lost.
- A partial batch answer resumes the waiting engine before every question is answered.
- An answered question is overwritten by a duplicate delivery or an answer racing with the dashboard.
- A phone answer starts a new queued turn instead of resuming the original waiting turn.
- Persistence/restart loses correlation, partial answers, delivery state or completion.
- A queued prompt is sent after its question was answered on the dashboard, stopped or paused.
- Telegram delivery is claimed twice or replayed after an uncertain send.
- A Telegram API refusal, lost receipt, long question or multipart question leaves a false delivered state.
- Secrets copied into question text leak through phone prompts.
- Another runner reads or answers a request it does not own.
- A stopped or paused turn continues receiving answers, or a stale answer becomes a new normal prompt.
- A quoted `/stop` becomes an answer instead of reaching the native command path.
- A malformed `/answer` starts another turn instead of giving actionable syntax guidance.
- A forwarded Telegram command is treated as an owner decision rather than outside data.
- Commas in free text are mistaken for multiple selections.
- Maintenance flush, checkpoint or compact turns create owner questions.
- A credential saved after queueing spans two WhatsApp chunks and defeats per-chunk redaction.
- A credential saved between Telegram sends or HTTP retries leaks through an already captured prompt.
- WhatsApp's one-day outbox cleanup deletes the only quote correlation for a still-waiting question.
- The replay leaves synthetic home directories, live timers, external connections or credentials behind.

Each result is written incrementally to `result.json`; failure details identify the native boundary that failed. Production source is never stubbed. The fake Telegram transport only returns synthetic message IDs and can deliberately refuse a send.

## Dashboard handoff failure inventory

Written before the native browser fixture. The browser uses the production app and an isolated synthetic SQLite home.

- A phone-selected option is absent or unselected when the dashboard question first appears.
- A phone free-text answer is absent from its associated textarea.
- A phone answer arriving after the form mounts does not update its fields.
- An unrelated incoming phone answer overwrites a local dashboard draft or a local option choice.
- Continue remains disabled although every question has an answer, or submits blank answers for phone-completed fields.
- Mixed phone and dashboard answers create a new turn or resume the original turn before the complete batch is submitted.
- A completed form stays pending, writes duplicate conversation history, or allows obsolete queued phone prompts to send.
- The fixture leaves an isolated server, Chrome process/profile, SQLite home, or external connection alive.
