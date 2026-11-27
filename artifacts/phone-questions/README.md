# Phone clarification replay

Run the native question lifecycle against a disposable SQLite home:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/phone-questions/run.mjs node_modules/.cache/phone-questions/result
```

The fixture calls the real runner-authenticated request/response endpoints, durable WhatsApp outbox, owner intake, Telegram update parser/intake and dashboard answer endpoint. Telegram's HTTP transport is replaced by an in-process synthetic Bot API. External network calls are rejected. No model or real phone is used.

`result.json` is written after every case and records whether the disposable home was removed. The native scheduler is stopped so queued brain work cannot execute. The fixture restarts the native database for its persistence case. Add `--baseline` to limit the run to the original missing-delivery regression and an ordinary-message control.

`--baseline` loads the original question, WhatsApp and intake module definitions from commit `c505a6d9f61177ab5449ef42e72c91d84094120a` into the same native runtime. Temporary sibling module files preserve their real relative imports and are removed at completion. The missing phone-delivery assertion must fail and the ordinary-message control must pass. The current source is never overwritten.

The failure inventory is in `failure-cases.md`. Preserve these maintained replay sources; remove generated output after verification.
