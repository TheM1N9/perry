# Internet reads and search

Audit of Perry at `9b00cdb` for #265:

| Existing capability | What it actually supports | Gap |
| --- | --- | --- |
| `read_page` / `convex/web.ts` | Exact public URL, Markdown, 5 MB network cap, checked DNS and redirects, browser fallback | No platform/operation routing or shared evidence contract |
| `browser` | Dedicated Perry profile, site-scoped saved logins, interaction approvals | Website interaction, not a public API or proof of full comments/transcripts |
| `list_connectors`, `find_action`, `run_action` | Current Composio discovery and connected account operations | Discovery does not prove an operation works; arbitrary results have provider-specific coverage |
| Engine web search | Engine-dependent search | Not available uniformly across engines; snippets are not retrieved sources |
| Pet Whisper / installed local tools | Owner audio transcription; engine shell under runner policy | No supported internet video downloader or video inspection tool |

The reviewed Agent-Reach [channel contract](https://github.com/Panniantong/Agent-Reach/blob/main/agent_reach/channels/base.py) and [doctor](https://github.com/Panniantong/Agent-Reach/blob/main/agent_reach/doctor.py) informed the separation between dependency checks and successful reads. This is a source review, not upstream runtime validation.

The implementation adds a read-only registry and deterministic router over these boundaries. It does not install Agent-Reach, copy browser profiles, obtain proxies, or configure accounts.

## Supported operations

Public reads never use an authenticated browser session or a connector implicitly. A supplied URL is the resource to read; a failed read is never replaced with a search summary. Search results are explicitly snippets, with separately retrieved originals.

| Platform | Public operations | Account operations |
| --- | --- | --- |
| Web | Exact page, DuckDuckGo HTML search (best effort) | Existing dedicated browser for authenticated interaction |
| GitHub | Exact page; issue/PR comments; issue/PR search | Current read-only connector discovery, explicit account selection |
| YouTube | Exact page; available manual/automatic captions | Current read-only connector discovery, explicit account selection |
| RSS/Atom | Feed entries, links, authors and dates | None |
| Reddit / X | Exact public page only; specialized adapters disabled until validated | Current connected operations, where available |
| Instagram / LinkedIn | Exact public page only; no promise of full posts, comments or analytics | Assessed through current connected operations, where available |

No platform's page-read support implies comment, transcript, search or private-account support. Optional paid backends and local shell adapters are not registered. Existing Composio usage is charged under the owner's configured plan and is used only for an explicitly requested connected scope.

Authenticated GitHub reads use Perry's checked token connection through
`list_connectors`, `find_action` and `GITHUB_REST_GET`. The internet adapter
does not discover or execute the retired Composio GitHub connection.

## Verification plan (written before implementation)

The repeatable check is `artifacts/internet-routing/run.ts`. It exercises actual routing/normalization against deterministic source fixtures, then the real SQLite runtime and MCP tools against a local public-site stand-in. Fixtures do not validate live connector credentials or platform access. Optional live probes must only read public sources.

Failure modes to cover:

- Lookalike hosts, URL credentials, secret query parameters, invalid schemes, private IPs, DNS rebinding and redirects into private services.
- Wrong operations: a watch page is not a transcript, a search snippet is not an original, a public read cannot substitute for account data or full comments.
- Empty successful results versus malformed JSON/XML, missing captions, unavailable or disabled backends.
- HTTP 401/403/429, rate-limit reset, deadlines, cancellation, bounded retries and oversized responses.
- Duplicates versus distinct reply IDs, pagination limits, truncation, missing dates and authors, automatic versus manual captions.
- Discovery failure isolated from other adapters, revoked auth, current slugs, explicit account scope, and refusal of writes/secret-related operations.
- Hostile source instructions remain untrusted and hold back writes, saved-login use and installation in the same turn.
- Diagnostic metadata contains no source text, tokens or cookies; dependency readiness is separate from a successful operation probe; refresh invalidates discovery checks.

## Limits

All network reads share a deadline, bounded output and per-source concurrency. Results disclose attempted backends, pagination and missing fields. No source-result cache is used (`cacheAgeMs: 0`); short-lived diagnostics are labelled with their check time. A successful probe is only evidence for that operation and time, not universal platform availability.

Captions are text only: no visual inspection or audio transcription is claimed. Private data never falls back to public search. A source that denies access remains a gap in the final answer, with the smallest relevant repair action.

## Operation limits and controls

Each top-level read has a 25-second deadline, shared with search's original reads. Public transport keeps its existing 5 MB response cap. Normalized content is capped at 30,000 characters per result; each search retrieves at most three separate original results. Captions additionally retain at most 500 segments / 30,000 segment characters. Result limits are 1–20; feed parsing retains at most 21 entries to detect incomplete coverage. GitHub comments/search read one page and disclose remaining coverage. Temporary API failures receive at most one 250 ms retry; authentication, policy, permission and rate-limit responses are never retried immediately. Retry-After is returned where available.

Public search uses the HTML search page, unwraps its result links and keeps snippets separate from originals. Access challenges and unrecognized formats fail explicitly; search snippets carry no inferred publication dates.

The live connector schema is validated with Zod's installed JSON Schema reader. Discovery is capped at ten read operations / 200 KB of schemas, account listing at three pages of 100, arguments at 12 KB, and connector results at 1 MB before normalization. Truncated account coverage cannot establish that an unlisted account has expired. Opaque connector data stays partial: provider pagination, source dates and completeness are not inferred. Account checks are cached for 60 seconds and carry check time/cache age; explicit execution always refreshes account status. Failures invalidate that cache.

Per-operation probes contain metadata only and live in the server process; restarting clears them. Checks older than 60 seconds are explicitly stale and no longer count as current readiness; their historical timestamps remain available. An installed browser, a configured key or a discovered action does not mark a read ready. The selected backend is cleared after a failed read, while the previous successful timestamp remains visible. Refresh clears account checks; it does not claim to have probed an operation. A subsequent read performs the actual probe.

For staged rollout or rollback, set `PERRY_INTERNET_DISABLED` to a comma-separated list of `public_page`, `web_search`, `github_api`, `youtube_captions`, `rss_feed`, or `connected`, then restart Perry. Existing `read_page` and authenticated browser workflows remain available. No additional dependency, account setup, proxy or installer is introduced, so rollback removes no shared tools or credentials. Registry environments describe supported Node/browser APIs; this change was exercised on macOS, not Windows.

RSS publication and Atom modification timestamps remain separate (`publishedAt` / `updatedAt`). Retrieval time is never substituted for either. Missing publication dates remain missing.

## Reproduce and inspect

Run from the checkout with its installed dependencies:

```sh
pnpm exec tsc --noEmit -p convex
pnpm typecheck
bun scripts/smoke.ts
pnpm build
bun build artifacts/internet-routing/run.ts --target=node --packages=external --outfile=artifacts/internet-routing/run.mjs
node artifacts/internet-routing/run.mjs
# Optional public network probes, without connected accounts:
PERRY_INTERNET_LIVE=1 node artifacts/internet-routing/run.mjs
```

The harness creates a temporary Perry home, local public-site stand-in and provider fixture. It uses the real SDK, SQLite runtime, MCP authorization, browser isolation and source transport, without running an engine or modifying an owner's data. Delete the generated `run.mjs` after running; it is not source.

Evidence is in [`result.json`](../artifacts/internet-routing/result.json), [`smoke.txt`](../artifacts/internet-routing/smoke.txt), [`build.txt`](../artifacts/internet-routing/build.txt), and the [settings screenshot](../artifacts/internet-routing/diagnostics.jpg). The build succeeds with existing dynamic-filesystem tracing warnings in browser, pet and wake code.

Public live checks read example.com, GitHub issue comments (an empty successful list), an RSS feed and public HTML search with separate original-read outcomes. The live YouTube probe exposed a caption track but returned no transcript from its caption endpoint; this is recorded as `missing_transcript`, not a successful transcript read. Caption normalization is fixture-verified. Live authenticated connector reads, optional specialized Reddit/X adapters, final model-written summaries and Windows execution remain unverified. Optional specialized adapters and new paid backends are not enabled.
