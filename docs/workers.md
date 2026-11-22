# Worker completion webhooks

External workers report completion directly to Perry. No job id or reporting
timer is needed. In a Perry chat, call `register_worker` before launching a worker.
Give it the worker name, absolute result path and optional `ask`.
Append its returned `command` to the worker's
instructions as the final step, after closing the result file.

From a terminal, the same helper is available as:

```powershell
perry worker register --name 'Build checks' --result 'W:\work\RESULT.md' --chat '<conversationId>'
```

It prints JSON with `command`, `eventId`, `token` and `expiresAt`. Run the returned
command exactly. It has this form:

```powershell
perry notify --completion <encoded-registration> --port 7377
```

The encoded registration contains the name, result path, question, event id and
token as base64url JSON. This protects arguments from shell parsing, including
Windows' `.cmd` launcher; it is not encryption. Never edit or override it.

The token expires after seven days and only submits that registered completion,
with its name, path, reporting question and destination. Perry stores its SHA-256
hash, not the token. The token cannot register workers or call the admin API.
Treat the command as a credential; do not paste it into issues or public logs.

The CLI reads up to 128 KiB of UTF-8 result text and POSTs its snapshot and path to
`/api/workers/notify`. The file may contain a failure report. Missing files,
directories and oversized results exit nonzero. No file is silently truncated.
The server never opens an arbitrary file named by an HTTP client.

For a local, trusted terminal, this also works with the installed dashboard key:

```powershell
perry notify --name 'Build checks' --result 'W:\work\RESULT.md' --ask 'Summarize the checks and remaining failures' --chat '<conversationId>'
```

`--chat` is optional and only applies to dashboard-key calls. Without it Perry
uses the owner's main messaging channel, or the dashboard when none is paired.
Scoped commands capture the chat at registration and cannot change it. A deleted
origin uses the same fallback. Task/job origins resolve to the owner's chat.

Perry atomically records the event, reserves a turn, and schedules immediate
preparation through its persistent SQLite scheduler. A busy chat queues this
report separately. A paused Perry or full chat queue refuses admission with 503;
no partial event is saved. The CLI retries transient HTTP/network failures up to
five times with the same payload. If it exits nonzero, retry the identical
command later. There is no background polling or reporting job.

Explicit `--event <id>` values remain idempotent across server/CLI restarts.
Dashboard-key calls without `--event` derive a stable id from the worker name,
path, question, destination and result text. Use a new event id for a later
completion with otherwise identical data. Reusing an accepted id with different
data returns 409. An accepted event is not rerun automatically if its model turn
later fails; inspect the turn error in the chat and request a retry there.

The result reaches Perry as outside evidence, alongside the instruction to read
it and report what was done, verified, and still open. It carries no authority to
perform new external actions. An HTTP success confirms durable admission, not
that an engine has already finished its reply.

Both HTTP routes reject cross-site browser requests and bound request bodies.
`POST /api/workers/register` accepts `name`, `result`, optional `ask` and `chat`,
authenticated by `x-perry-key`. `POST /api/workers/notify` accepts `name`,
`result`, `text`, `eventId`, optional `ask`, `chat`, authenticated by `x-perry-key`
or `Authorization: Bearer <scoped token>`. CLI traffic uses loopback HTTP;
`--port` selects a nondefault local port.

Repeat the regression with Node 22.15+ and Bun installed:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/worker-webhook/run.mjs <disposable-output-directory>
```

It writes `result.json` after exercising HTTP, CLI subprocesses, SQLite and durable
turn reservations. It does not call a paid model. See the failure cases alongside
the replay for its coverage and limits.
