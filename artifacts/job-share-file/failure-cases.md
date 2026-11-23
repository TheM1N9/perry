# Job file delivery regression

Run with:

`pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/job-share-file/run.mjs <disposable-output-directory>`

The real SQLite runtime runs jobs, MCP share_file, turn completion, finalization,
notification admission and release, and WhatsApp acknowledgement. Telegram's API
is recorded at the fetch boundary. No real account or engine is contacted.
Each run writes result.json; CI retains it as an artifact.

Failure inventory, written before the regression and implementation:

- Finalization loses the turn's files while forwarding its text.
- An origin or the owner's default channel routes files somewhere else.
- Local files lack Telegram storage copies because job chats use the web channel.
- Stored Library files or generated images disappear from delivery.
- Files arrive out of share order; chunked text or retries overtake earlier files.
- Sharing twice duplicates an attachment; finalization or completion replays resend it.
- Quiet hours or the daily limit hold text but lose or prematurely send files.
- Multiple held runs mix up their files or lose their own receipts.
- Missing, removed, oversized, unreadable or API-rejected files silently count as sent.
- A WhatsApp enqueue is mistaken for transport acknowledgement.
- A transient failure becomes permanent too soon or a permanent failure stays successful.
- Partial failure discards later files, claims all files were shared, or fails to update the job report.
- A late older run overwrites a newer run's report.
- A stopped or quiet run unexpectedly sends files, or a file-only run sends nothing.
- Web delivery loses attachment links; text-only and legacy notification paths regress.
- A changed or unpaired recipient receives files admitted for someone else.
- Unlink, logout or owner replacement leaves queued rows or a flush snapshot able to send private files.
- Partial delivery releases a daily-limit slot, while a genuinely unsent attempt must release it.
- Tests touch the running installation, leak timers, or leave disposable data behind.
