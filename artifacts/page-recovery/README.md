# Dashboard error recovery

Failure inventory, written before the journey:

- A failed page query escapes its boundary, blanks the dashboard or removes navigation.
- An immediate Try again reads the retained failure without making a fresh request after the server recovers.
- Navigation to a healthy route keeps the old boundary failure visible.
- An ordinary shared-shell query fails outside the page boundary and removes every recovery control.
- A rejected dashboard key leaves private chat data visible, prevents locking, or cannot be replaced without a reload.
- An obsolete backend function shows generic guidance instead of the server-version repair instruction.
- Recovery silently replays writes, duplicates subscriptions, or retains the failed query after unmount.
- A fixture invokes real providers, downloads a model, leaks its home/browser/server or claims recovery without a fresh successful query.
- Repeated error/retry cycles add duplicate subscriptions or issue more than one replacement request.
- Unlock again keeps the rejected key in localStorage; a wrong replacement key admits private content or poisons the subsequent correct-key retry.
- The manual `--serve` mode reports setup as if recovery controls had been exercised.
- A transient HTTP 500/502/503/504 read failure replaces a healthy page instead of recovering within two retries; a persistent failure retries forever instead of presenting recovery controls after three total attempts.
- Leaving the page during read backoff leaves a timer or starts another request; authentication, missing-function and configuration errors are incorrectly retried.
- A failed mutation is replayed by read-recovery logic, creating duplicate owner data. One-off unlock queries must recover from a transient server error without retrying a wrong key.
- Navigation cancels a response after its headers arrive; collecting its body waits forever and prevents the report and teardown. Inspect upstream response bodies before delivering them to the browser, bound upstream requests, and fail explicitly if inspection fails.

The chat-history recovery scenario opens only a newly created synthetic chat.
Its normal read receipt and the browser timezone are the only accepted browser
writes. An injected failed **New page** request must occur exactly once and
must leave the fixture note unchanged.

Use a production build and an isolated home. The fixture blocks external server fetches and uses the existing deterministic embedder. It never launches an engine or uses the owner's Perry. The automated mode attaches Playwright to the one native Chrome/profile already opened by the existing Perry harness.

```powershell
$env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp'
$env:TMP = $env:TEMP
$env:PERRY_E2E_DIR = $env:TEMP
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/page-recovery/run.ts node_modules/.cache/page-recovery-automated
```

The default is automated acceptance. Its `result.json` explicitly records `mode: automated-browser-acceptance` and `acceptance: completed` only after the full browser journey finishes. It records query request counts/timing, response write tables, note identity, browser errors and normal Temp-home teardown. `recovered-brain.png` is the final native browser screenshot. Every recovery must receive a fresh successful query within two seconds and make exactly one replacement request, rather than waiting for the previous five-second failed cache entry to expire.

Append `--serve` to expose only that fresh fixture for manual shared-browser use; press Enter to finish (bounded to 15 minutes). It records `mode: manual-fixture-only`, `acceptance: not-run` and no recovery checks. Successful server setup/teardown in that mode is not product acceptance. The manual fixture creates its own home/server and must not be confused with personal Perry on port 7377.

## Observed baseline and repair

Root manually drove a separate shared-preview fixture on production build `42ad2d3a-99ce-4e99-92f4-ebb8b7579c43`:

- `notes:list` returned 500 and the page boundary appeared. After restoring the endpoint, immediate **Try again** left the error visible after 802ms with the query count unchanged at 3. Recovery worked only after the old five-second cache TTL elapsed.
- A failing shared `dashboard:listChats` query escaped the inner page boundary and showed the framework's Reload/Back screen, without Perry's recovery controls.

The product repair drops idle errored query snapshots immediately, so remounting can subscribe and fetch again. A native outer `PageErrorBoundary` now contains shared `Unlocked` queries and omits the sidebar-dependent top bar; the existing inner boundary still preserves sidebar navigation for page-specific failures. These changes belong to root, not this fixture lane.

Root then manually accepted the repaired behavior on build `48d079fa-18b0-4f24-9c6f-6209f69086ec`: immediate page/shell retry took 31ms/30ms with one fresh query, obsolete-function guidance was specific, healthy navigation reset the native boundary and shared-key rejection could return to the gate. Those are root's separately driven manual observations; the automated evidence below is an independent synthetic journey.

## Automated acceptance

On the same repaired build, `2026-11-25T11:05:04.006Z`, all **15 checks passed**:

| Recovery | Actual request count | Fresh HTTP 200 |
| --- | --- | --- |
| Immediate page retry | 1 → 2 | 57ms |
| Repeated page retry | 3 → 4 | 51ms |
| Retry after obsolete-function guidance | 6 → 7 | 44ms |
| Immediate shared-shell retry | 9 → 10 | 55ms |

Every retry restored the same note and dismissed the boundary. Native client navigation to Library preserved a same-document marker and cleared the page failure. A shared 500 showed Perry's Try again/Reload controls. An injected shared 401 hid the note and sidebar, then **Unlock again** removed the remembered key. A real wrong replacement key returned 401 without unlocking; the correct key performed fresh status queries and restored the unchanged note.

The report recorded no response writes, no owner note/chat mutation calls, one unchanged fixture note, no browser runtime errors, no runner/model turns and `tempHomeRemoved: true`. The server/browser stopped normally. The final screenshot was inspected and shows the recovered note with the healthy sidebar. Main and artifact typechecks plus `git diff --check` passed. The report/PNG remain under the supplied cache output path; explicit diagnostic cleanup was not retried in this wave after prior policy rejections. Native Temp home/profile cleanup completed normally.

Faults are injected at the actual browser HTTP boundary; key replacement uses the real backend validator. This verifies these particular recovery contracts, not live provider/account behavior or a new long-duration leak soak. No product source changed during this fixture run and root's separate manual fixture was neither driven nor stopped.

## Transient read acceptance, 26 November 2026

The extended production-browser journey passed 26 checks using Playwright
1.62.1 and real HTTP/SQLite with synthetic data. The unmodified client failed
the first transient-500 scenario; the repaired client restored the note and
chat composer after the next successful read, without presenting a page error.
The journey also covers transient 502/503/504 responses, a shared-sidebar read,
three-attempt exhaustion, navigation during backoff, immediate manual recovery,
key rejection and replacement, and a failed note-creation request sent once.
The fixture note retained its identity and content, no runner/model work was
started, and the isolated home was removed normally.

The navigation scenario waits for the failed response to finish and observes
the browser scheduling its retry before leaving. A distinct `Retry-After`
delay identifies that timer; the observer preserves native timer behavior and
retains its ID through client navigation. Acceptance requires a matching
native `clearTimeout` call within two seconds and exactly one note request.
Both timer observers are restored in `finally`. This directly verifies timer
cancellation even if a stale callback would suppress its own network request;
it uses no fixed delay to infer cleanup. The report records
`navigationRetryCancelled: true`. The strengthened journey passed all 26
checks again.

The first hosted Windows run passed 24 checks, then reached GitHub's six-hour
job limit while collecting response bodies from pages that had navigated away.
Local replay also exposed Chrome discarding those bodies. The route handler
now reads each real upstream response with Playwright's `route.fetch` before
fulfilling the browser request, with a five-second deadline, no automatic
retries or redirects, and response disposal after fulfillment. Inspection
errors fail acceptance and appear in the report. The repaired journey passed
all 26 checks with no body-inspection failures and normal home teardown.
The hosted recovery step also has a five-minute limit.

Only read queries retry server errors, with at most two additional attempts.
Authentication, missing-function and dashboard-key configuration errors retain
their existing handling. Mutation/action replay rules are unchanged. This
recovers from a temporary failure; it does not identify an earlier server
exception whose diagnostics were discarded. Background mode now retains only
the sanitized operation/class diagnostic, without request arguments or private
exception details. CI runs this journey on Windows and uploads its evidence.
