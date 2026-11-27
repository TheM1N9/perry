# Native browser verification replay

This replay starts Perry's native SQLite Runtime and calls its authenticated MCP browser tool. It launches disposable Chrome profiles, serves local synthetic verification pages, and uses Perry's owner-control API for takeover, completion and Resume. It does not start model turns, access real accounts or complete real verification challenges.

Run from the repository root with installed dependencies and Chrome available:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/browser-verification/run.mjs node_modules/.cache/browser-final-current
```

Set `PERRY_BROWSER_PATH` if Chrome is installed elsewhere. A local desktop is needed to exercise headed browser launch. The public-reader and form scenarios remain headless. The replay uses a new `PERRY_HOME` for each run and never loads the owner's Perry profile.

Each run writes an incremental `result.json`, exits nonzero for a failed check, and reports profile/process cleanup. Remove the disposable output directory after reviewing it. The maintained replay and failure inventory stay in the repository.

To reproduce the pre-fix behavior, add `--baseline`. A native module load hook reads the affected modules from commit `e89a386f70b697fd09b34f76ad3309dd861c7d63` without changing the working tree:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/browser-verification/run.mjs node_modules/.cache/browser-final-baseline --baseline
```

The replay covers launch overrides and idle ownership, structured checking/required/failed states, hidden and solved widgets, rejected tokens, secret-field redaction, submit guards, Retry and ordinary field entry, same-page recovery, stale browser identities and stopped-turn authorization. A native encrypted vault entry verifies that blocked saved-login submission does not reveal the secret, while explicit `submit:false` can fill it without submitting or exposing the password. The ten-minute idle callback is captured and invoked directly so ownership protection can be verified without a ten-minute delay; normal native launch, MCP and page actions are not mocked.

To reproduce the two review regressions, use `--baseline=17a53d0eadba322494e78a52691099dc4682ead1` instead of `--baseline`. That version fails the image-submit and changing-button approval cases; the current implementation passes all 43 checks.

A visible iframe with a Cloudflare hostname and no readable parent challenge copy is included. The fixture's CSP prevents loading its external URL. This proves recognition from the known iframe element, not reading or completing a real cross-origin challenge. A deferred widget produces its synthetic token only when the form submits; this confirms that checking alone can initiate legitimate verification. A separate approval-wait case verifies the live page is checked again after approval.

The local verification pages exercise Perry's interpretation and recovery behavior. They do not establish that an external site's bot policy will accept automation. Cross-origin iframe copy is unreadable, so a known iframe without parent challenge text reports checking. Multiple widgets and custom token-field names are outside this replay: a standard nonempty response can mask another pending widget, and custom response fields may not clear the inferred status.
