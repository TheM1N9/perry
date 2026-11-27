# Native phone-question verification

The source baseline at `c505a6d9f61177ab5449ef42e72c91d84094120a` reproduced the bug: an authenticated runner saved its native question, but the owner WhatsApp outbox contained zero question messages instead of one. An ordinary inbound message remained ordinary in the same baseline run.

The current implementation passed all 40 native replay cases. Coverage includes WhatsApp quoted replies, explicit codes, option labels, free text, multi-select, partial batches, restart persistence, stale and duplicate replies, dashboard races, stop/pause, pairing and owner changes, multipart delivery, credential redaction, owner/runner isolation, Telegram message-ID parsing, durable update receipts, delivery claims and uncertain sends.

Additional boundary checks confirm that quoted `/stop` reaches the native command path, malformed answer commands provide guidance, forwarded Telegram text cannot answer questions, and maintenance turns cannot request input. A still-waiting question remains answerable after the native one-day WhatsApp outbox collection. Credentials saved after queueing revoke captured WhatsApp prompts even when a credential crosses the chunk boundary; Telegram stops captured text between chunks and before a rate-limit retry when a newly saved credential changes the redacted prompt.

The lifecycle passes through the actual schema, SQLite store, runtime, question endpoints and channel intake. The Telegram network boundary is synthetic; no real phone messages or model turns were started. Every disposable native home was removed. The runner's engine-provider adapters are outside this replay; they already call the shared question endpoints, and this verification does not claim a live paid-model conversation.

Rerun the commands in `README.md` to produce a fresh incremental `result.json`. The baseline should exit with its single missing-delivery failure; the current run should exit successfully.
