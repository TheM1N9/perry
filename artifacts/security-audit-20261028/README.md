# Security audit and remediation evidence

This directory publishes the original local audit bundle for issue #324.
`baseline-*.json` and `baseline-*-replay.mjs`/`baseline-replay.mjs` preserve the
original vulnerable outcomes and reproductions against `75a0788`. Those scripts
are historical evidence and intentionally do not pass on a remediated checkout.
Their probe logic is preserved; reruns now write separate ignored
`baseline-*-result.json` files rather than overwriting the recorded snapshots.

The current `run.mjs`, `client-replay.mjs`, and `lifecycle-replay.mjs` assert the
new protections: active-document downloads, path-rule boundaries, bounded
request bodies/admission/SSE buffers, transaction-safe byte deletion, client
cancellation/deadlines, and polling cleanup. They use synthetic data and the
real Runtime, HTTP handlers, cache, and a disposable Chrome profile where
available. They do not use owner accounts or a real model. Live outputs are
`result.json`, `client-result.json`, and `lifecycle-result.json`; named
`verified-*.json` files are recorded snapshots and are never CI upload inputs.
Current inventories use ignored `function-inventory-result.json` and
`indexes-result.json`; the original committed inventories remain unchanged.

Review follow-ups cover transactional action deletion, fair cleanup retries,
serialized file imports, UNC scope, actual filesystem links, and query retry
teardown. Writes that lose their transport acknowledgement raise
`WriteOutcomeUnknownError`: the server may have committed them. Mutations and
actions are never automatically replayed; callers need durable operation IDs
before retrying an uncertain write. Chat-wide idempotency remains F08 work.

This is a partial remediation of #324. Network binding/TLS (F03), dependency
advisories (F05), durable Telegram ingestion (F07), chat idempotency (F08), and
pairing budgets (F11) remain open. Global admission limits do not provide
per-address fairness or replace front-door/proxy limits. Reverse-proxy/TLS and
live-runner filesystem-boundary acceptance still need verification. The
historical audit below must not be read as a current clean bill of health.

Replay current protections with Node 22.15+ or Node 25 and the installed packages:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/security-audit-20261028/loader.mjs artifacts/security-audit-20261028/run.mjs
pnpm exec node --experimental-transform-types --import ./artifacts/security-audit-20261028/loader.mjs artifacts/security-audit-20261028/client-replay.mjs
pnpm exec node --experimental-transform-types --import ./artifacts/security-audit-20261028/loader.mjs artifacts/security-audit-20261028/lifecycle-replay.mjs
pnpm build
pnpm exec bun artifacts/security-audit-20261028/deployment-replay.ts
```

The deployment replay starts the production build on a disposable loopback
port and checks the actual dashboard headers, stored-document response, and
dashboard startup in isolated Chrome. It uses a synthetic home and no runner.
Its live output is `deployment/result.json`; CI runs the three handler/client/
lifecycle replays on each supported OS. Deployment acceptance is run locally
because it requires a production build and installed Chrome.

## Original audit — 28 October 2026

Audited `main` at `75a07880cae2a29022960b61b8fa4057f6caab70` (PR #322). `git pull --ff-only origin main` reported already up to date; HEAD and origin/main match. Application code and lockfiles were not changed. All new files are audit evidence in this directory.

**Result: 12 prioritized findings: five high, six medium, one low.** The most urgent application issues are active stored content executing on the dashboard origin, a path traversal in saved file approvals, and broad HTTP exposure. Dependency scanners also report critical advisories in the separate site lockfile, with feature-dependent exploitability described below. This is not a clean bill of health or a claim of ASVS certification.

## Scope and confidence

Reviewed the local Next.js dashboard and API routes, custom SQLite/Convex-compatible runtime, runner authentication and permissions, messaging ingestion and delivery, pet pairing and Electron configuration, browser controls and public fetches, notes/queue/cache behavior, installation, CI, and all four package lockfiles. Enumerated **611 backend definitions, including 257 public definitions**, in [function-inventory.json](function-inventory.json). Direct-auth marker absence was manually followed through the queue, todos, workspace and Codex-to-engine helper/delegation paths; it is not automatically an authentication vulnerability.

Fresh verification uses actual application handlers over loopback HTTP, the real Runtime/SQLite/validators, a disposable Chrome profile, and synthetic transport adapters where stated. **16 HTTP/runtime scenarios, four client/cache scenarios and one polling lifecycle scenario completed successfully**, meaning the checks reproduced the stated outcomes, including vulnerabilities. The existing 23-scenario credentials replay and platform smoke checks passed. Root and Convex TypeScript checks passed. See [baseline-result.json](baseline-result.json), [baseline-client-result.json](baseline-client-result.json), [baseline-lifecycle-result.json](baseline-lifecycle-result.json), and [credentials-result.json](credentials-result.json).

The HTTP adapter does not exercise Next.js middleware, production rendering, reverse proxies, or hosting configuration. No deployed Perry was attacked; no real engine, connected account, personal browser profile, credential or message was used. Provider delivery, live Vercel settings/deployed SHA, Tailscale ACLs, OS sandbox enforcement, production query latency, power-loss behavior and multi-day soak behavior remain unverified. The installed Node runtime here is 25.8.2 on Windows. These are bounded application-flow reproductions, not a complete production penetration test or a model-driven full product E2E.

The benchmark is [OWASP ASVS 5.0](https://asvs.owasp.org/), [OWASP API resource-consumption guidance](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/), and the linked specialist guidance below. Current GitHub advisories and installed framework/library source were checked. [Reddit's API-throttling discussion](https://www.reddit.com/r/nextjs/comments/17tcsov/throttling_the_apis_to_prevent_a_dos_attack_on/) was used as a practitioner abuse-case prompt; technical conclusions rely on primary sources and Perry evidence.

## Findings

### F01 — High: stored HTML can steal the dashboard bearer key

**Location:** `app/api/backend/storage/[id]/route.ts:8–11`; `server/runtime.ts:378`; `components/dashboard/shell.tsx:35–41`.

Stored files are returned anonymously to anyone possessing their capability URL, with their supplied MIME type, no attachment disposition, no sandbox CSP and no `nosniff`. Unlike `app/api/media/store.ts`, this handler does not force active content to download. A stored `text/html` document therefore executes on the dashboard origin. The dashboard's full bearer key is in localStorage on that origin; it also authorizes `/api/backend/admin`, including internal functions.

**Reproduced:** a synthetic HTML document, served through the real handler, opened in a fresh headless Chrome profile and read a synthetic dashboard key from localStorage. `syntheticKeyReadableInChrome=true` in baseline-result.json. No real key was involved.

**Precondition:** attacker-influenced content must enter storage and the owner must open its URL on an already-unlocked origin. This is not an anonymous upload bypass. Telegram files and imported content make treating every stored document as trusted inappropriate.

**Fix:** share the existing safe file-serving policy; force HTML/SVG/XML and other active formats to download as octet-stream with `nosniff`, or isolate user content on a credential-free origin. Add a sandbox CSP as defense in depth. Consider server-managed, scoped sessions instead of a full admin key accessible to every same-origin script. [OWASP file-upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) addresses active content and safe retrieval.

### F02 — High: saved file-approval rules accept `..` escapes

**Location:** `convex/approvals.ts:44–52,122–133,191–197`.

`normalPath` adjusts slashes and case but does not resolve dot segments; `inside` uses a string prefix. A saved allow rule for `C:\audit\allowed` auto-approves `C:\audit\allowed\..\outside.txt`.

**Reproduced:** the public `approvals:request` flow returned `next:run`, with durable `decidedBy:rule`, for that escaped path. An unrelated sibling path correctly returned `ask`. The replay only requested decisions; it performed no file write.

**Precondition:** an applicable saved rule and a runner/engine request containing the noncanonical path. A downstream sandbox may independently refuse the write; the approval boundary itself is bypassed.

**Fix:** resolve paths using the runner platform's path rules before comparison; reject ambiguous/relative paths. Have the runner check real filesystem targets where symlinks or junctions matter. Apply equivalent canonicalization to rule `cwd` comparisons. Require exact path-component boundaries. [OWASP authorization guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html) calls for validation at the actual enforcement boundary.

### F03 — High, deployment-dependent: dashboard and keys exposed over LAN HTTP by default

**Location:** `scripts/perry.ts:90–110`; `package.json` dev/start scripts; `client/backend.ts:86–92`.

The default listener accepts every interface and the CLI advertises `http://` LAN addresses. Dashboard and runner keys, commands and private responses travel over that transport. A hostile LAN participant able to observe/alter traffic can compromise this high-privilege assistant. Tailscale-encrypted traffic is a different transport and mitigates observation on its path; an ordinary LAN URL does not inherit that protection.

**Evidence:** source-confirmed defaults; no interception or live-network probing was performed.

**Fix:** default to loopback and require explicit remote enablement, or bind only the intended private interface. Require HTTPS for nonloopback dashboard, runner and pairing traffic. Use a reverse proxy or an authenticated encrypted tunnel and restrict its access. The installed Next.js self-hosting guide and [official self-hosting guidance](https://nextjs.org/docs/app/guides/self-hosting) recommend a reverse proxy for transport-facing protections. `server/browser-api.ts` already requires HTTPS for remote live-browser access; extend this policy consistently.

### F04 — High for reachable installs: anonymous resource consumption is unbounded in application code

**Location:** `server/api.ts:12–18`; `app/api/backend/storage/upload/route.ts:5–9`; `app/api/backend/events/route.ts:9–26`; `server/runtime.ts:100–104`.

Public function calls parse the complete JSON body before handler authentication. The legacy storage-upload route reads the whole body before checking the ticket and has no byte cap. Anonymous SSE requests each install a listener and interval, without a connection budget. These compete for memory, sockets and the single backend process; random bearer keys do not prevent pre-authentication exhaustion. The exclusive operation queue also has no application admission limit. The 50 MB check in `/api/media` does not cover the legacy upload route, and its undeclared/chunked bodies are buffered before the final size check.

**Reproduced:** an invalid upload consumed its three-byte probe before returning 403; 12 anonymous event streams were accepted, installing 12 listeners and triggering Node's listener warning. Ordinary stream cancellation removed them. A request already aborted before handler entry still installed a listener until explicit stream cancellation. No stress test or memory-exhaustion attack was run.

**Fix:** authenticate/validate capabilities before body processing, enforce streaming byte ceilings regardless of Content-Length, limit concurrent streams/actions/queued operations, and add per-address plus per-credential request budgets. Handle already-aborted signals before registering resources. Use front-door limits too. [OWASP API4](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/) covers these independent dimensions. [Vercel WAF rate limits](https://vercel.com/kb/guide/add-rate-limiting-vercel) can protect the hosted site; they do not protect this independently running local backend.

### F05 — High: known dependency advisories across independent lockfiles

Registry results were preserved verbatim as `dependency-{root,site,pet,film}.json`. Counts are advisory/package instances, not distinct exploitable bugs:

| Project | Critical | High | Moderate | Low |
| --- | ---: | ---: | ---: | ---: |
| Root dashboard/runner | 0 | 4 | 7 | 2 |
| Separate Vercel site | 2 | 4 | 5 | 1 |
| Desktop pet | 0 | 3 | 3 | 0 |
| Film tooling | 0 | 1 | 0 | 0 |

Priority applicability:

- **Root `undici` 7.29.1:** [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c), fixed in 7.30.1. A malicious HTTP response can crash Node despite a caught fetch rejection. Perry's public-page reader directly imports this fetch implementation, making hostile external responses relevant. No crash payload was executed.
- **Site `next` 16.3.6 / `sharp` 0.35.4:** [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw) concerns image-optimization RCE with SVG on glibc Linux; Next >=16.4.1 or sharp >=0.35.5 addresses the reported issue. The second critical advisory, [GHSA-673q-mjm6-r5xr](https://github.com/advisories/GHSA-673q-mjm6-r5xr), needs Cache Components and a `use cache` function returning multiple typed arrays. No `use cache`, `cacheComponents` or `next/image` usage was found in site sources. That narrows known feature exposure but does not establish that framework endpoints are disabled. Deployed version, platform mitigation and active optimization routes were not inspected.
- **Pet `electron` 44.4.5:** the certificate-blocklist advisory [GHSA-jr5w-w6x2-84p9](https://github.com/advisories/GHSA-jr5w-w6x2-84p9) requires >=44.9.1 on this major line. The separate pointer-lock advisory has narrower iframe/permission-handler prerequisites and no matching custom handler was found. Pet's sharp and undici findings also need their use paths assessed.
- **Root Zod, SDK transitive dependencies and site build tooling:** see raw paths/ranges. Zod 4.6.5 has a >=4.6.6 fix, while a transitive 3.x instance requires an upstream-compatible upgrade. Hono, body-parser, IP parsing and URI handling advisories do not prove that Perry runs the affected server/helper features. Site `source-map-js` is build tooling. Do not force transitive major versions without compatibility checks.

**Fix:** update all four lockfiles independently, prioritize directly reachable fetch/native/browser dependencies, verify behavior and rescan. Root overrides do not apply to the independent site/pet projects. Add dependency and security-flow checks to CI; the current workflow typechecks and runs smoke/lifecycle checks but no dependency-audit step. Root Next 16.4.2 was not flagged by this scan.

### F06 — Medium: database rollback cannot restore deleted attachment bytes

**Location:** `server/runtime.ts:407–410`; `convex/dashboard.ts:308–318`; `convex/library.ts:499`.

`ctx.storage.delete()` unlinks the filesystem file inside a SQLite mutation. If a later operation fails, SQL rolls back the metadata and references, while the file stays deleted.

**Reproduced:** injected a late database-delete failure in the real `dashboard:deleteChat` transaction against a disposable conversation. Conversation, attachment and storage metadata returned after rollback; file bytes did not. This can lose data during disk/IO failures without an attacker.

**Fix:** commit a durable deletion job/tombstone first, then unlink after commit with idempotent retry and orphan reconciliation. Avoid irreversible filesystem changes inside a rollbackable SQL unit.

### F07 — Medium: failed Telegram ingestion is acknowledged and skipped

**Location:** `server/telegram.ts:81–84`.

The polling loop catches an ingestion error and then advances the saved offset unconditionally, contradicting its stated retry behavior. The update can be permanently lost before durable acceptance.

**Reproduced:** injected failure for update 456 still stored the next offset as 457.

**Fix:** advance only after a durable accepted/ignored decision. Retain failed updates for bounded retries with a visible dead-letter state. Deduplicate by Telegram update ID so recovery and ambiguous outcomes do not duplicate side effects.

### F08 — Medium: retries with the same chat message key enqueue duplicate work

**Location:** `convex/dashboard.ts:904–931`.

`messageKey` associates attachments but does not deduplicate `sendChat`. An uncertain network outcome followed by resubmission can create two turns, potentially repeating agent side effects. Serialization prevents lost updates but does not provide idempotency.

**Reproduced:** two identical concurrent HTTP sends with one fixed messageKey both succeeded and added two durable turns. No engine ran. The per-chat queue cap of ten is present and is not an idempotency mechanism.

**Fix:** persist an owner/conversation/request ID with the accepted operation and return its existing result on replay. Require a stable client-generated ID and define conflict behavior for a reused ID with different text/attachments. Carry idempotency through provider-facing effects where possible.

### F09 — Medium: ordinary client calls lack a cancellation/deadline policy

**Location:** `client/backend.ts:86–92,263–290,401–407`; `convex/lib/telegram.ts:82–90,424–430`; `server/telegram.ts:54`.

The SSE transport has an AbortController, but ordinary backend fetches have neither a caller signal nor an application deadline. Client close clears state and aborts SSE while leaving those calls running. A stuck subscription retains `inFlight`, and later refreshes join that pending operation until it settles or the platform times out. Several outbound Telegram calls similarly omit an explicit deadline.

**Reproduced:** a controlled pending client call was not given an AbortSignal and continued across close. This was a synthetic transport replay, not an actual long network outage. The connected Internet reader already uses an explicit 25-second cancellation-aware policy; this is not absent everywhere.

**Fix:** compose lifecycle cancellation and per-operation deadlines. Reject/clear pending state cleanly on close and unmount. Retry safe reads with bounded jitter; only retry mutations when an idempotency key exists. Respect provider Retry-After. Telegram's outbound 429 handling already supplies bounded retry logic when invoked with a signal.

### F10 — Medium: idle polling accumulates abort listeners in a long-running process

**Location:** `server/telegram.ts:22–25`; same sleep helper in `server/whatsapp.ts:129–132`.

Each completed delay leaves its `{once:true}` abort listener attached. `once` removes the listener only if abort fires, not when the timer completes. Telegram's no-token loop does this every 15 seconds: approximately 5,760 retained listeners/day until stop. WhatsApp has the same source pattern, although its complete running lifecycle was not replayed.

**Reproduced:** the actual Telegram polling loop, with only its idle delays accelerated, retained 12 listeners after 12 completed waits. Stop removed those listeners, but the post-query continuation then registered one more wait against the already-aborted signal. SSE's already-aborted initialization issue is separately covered in F04.

**Fix:** use the existing native `node:timers/promises` delay with a signal, or explicitly remove the listener when either path settles; handle an already-aborted signal immediately. Verify teardown with a sustained idle/offline replay. Do not hide this by increasing listener limits.

### F11 — Medium, limited to pairing windows: Telegram ownership code has no attempt budget

**Location:** `convex/installation.ts:19–25,258–269`; `convex/ingest.ts:157–182`.

Phone ownership uses a six-digit code generated with `Math.random`, valid for an hour. Wrong guesses do not consume attempts, lock or rotate it. Bot API limits are an external throughput constraint rather than a Perry authentication policy. This matters before ownership is claimed; existing claimed-owner checks constrain subsequent access. The independently implemented pet code has a miss budget and does not share this defect.

**Evidence:** source review; no guessing attack was performed.

**Fix:** use cryptographic randomness, shorter validity, persistent per-pairing and per-sender attempt budgets, throttling and explicit regeneration. Preserve the atomic one-owner transition. Rate-limit rejection replies as well.

### F12 — Low: inconsistent security headers and authentication error handling

**Location:** `next.config.ts`; `site/next.config.ts`; `server/api.ts:22–25`.

The separate site config supplies `nosniff`, frame denial and referrer policy; the local dashboard config supplies no global equivalents or CSP. A wrong dashboard key is classified as a 500 and logs a stack trace, so normal rejected traffic looks like internal failure and can amplify log noise. Raw backend error messages are returned to callers. These are defense/observability gaps, not a demonstrated login bypass. Framing exploitability and deployment-added headers were not tested.

**Fix:** establish consistent frame, referrer, content-type and CSP policies compatible with the dashboard; use HSTS only on the HTTPS deployment. Give authentication/authorization errors typed 401/403 responses and bounded sanitized logs. Enforce Origin/Fetch Metadata for browser-sensitive state-changing endpoints as defense in depth; bearer keys still remain required.

## Coverage against the requested conditions

| Condition | Existing implementation | Result and remaining work |
| --- | --- | --- |
| Race conditions/concurrency | One SQLite writer queue, BEGIN IMMEDIATE, nested savepoints; atomic checks inside claims/decisions | Fresh races verified one claim, one decision, one upload redemption and one note revision winner. F02 and F08 remain independent semantic boundary/idempotency defects. Multi-process simultaneous servers were not validated. |
| Database indexing | 140 generated SQL indexes, FTS triggers, vector index invalidation, scheduler time index | Auth lookup, runner/status queue and scheduler plans use intended indexes. Actual plans are saved in indexes.json. The first two hand-written representative SQL plans also use temporary ordering B-trees; optimize only after capturing the exact production query/parameters and measuring. Upload cleanup demonstrably scans _uploads because ticket-or-expiry lacks an expiry index. |
| API limits | Input schemas, some output/body caps, ten queued messages/chat, provider-aware retry in selected paths | These do not cap pre-auth body buffering, stream counts or process concurrency. F04. No distributed limiter is needed for a single process unless deployment changes; native proxy and bounded local admission are sufficient starting points. |
| Cache invalidation | Table-write events, dependency-aware refetch, reconnect refresh, cache generation/revision guards, bounded recent-chat retention | Fresh invalidation, late-response-after-lock and reconnect probes passed. Recent history is limited to 30 first pages / 4 MB / two minutes in client/recent-chat.ts. Remaining concern is F09 and cached media: storage URLs are nonrevocable bearer capabilities with year-long immutable private caching. Logout cannot erase copies already downloaded. |
| Network failure | Selected HTTP deadlines, redirects checked, Telegram 429 backoff, durable queues and turn recovery | F07/F08/F09. Scheduler actions are intentionally removed before execution and run at most once; a crash/network error may lose the scheduled attempt. Business-specific reconciliation is needed before claiming end-to-end delivery. |
| Security vulnerabilities | Single-owner key checks, internal/public separation, revocable pet scopes, active-turn MCP checks, credential encryption, guest tool allowlists | F01–F05/F11/F12. Authorization smoke is representative, not a proof over every possible object relationship. OS/vendor sandbox and prompt-injection defenses were reviewed but not red-teamed across live engines. |
| Long-lived process health | Cache eviction, browser cast teardown, bounded live Claude sessions | F10; canceled ordinary SSE streams cleaned up, but already-aborted entry needs a guard. Days-long heap/socket telemetry remains to be collected. |

Database scalability is not an absence-of-indexes problem. `dashboard:listChats` collects/hydrates all eligible chats and some settings paths scan historical collections; their synchronous work runs on the backend's shared process. Capture realistic EXPLAIN/latency/heap evidence before adding indexes, then paginate hot lists and use composite indexes matching equality/range/order. No production latency or throughput claim is made here. SQLite uses WAL with synchronous=NORMAL: [SQLite documents](https://www.sqlite.org/pragma.html#pragma_synchronous) that this preserves consistency but can lose recent committed transactions on power loss. Use FULL where acknowledgement durability requires it, and verify backup restoration with the credential key.

The public HTTP reader has a strong socket-pinned DNS allow check and manual redirect checks; fresh probes rejected loopback, RFC1918, metadata, mapped IPv6, unusual numeric loopback and unsupported schemes. This aligns with [OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html). A browser fallback uses preflight DNS checks plus response-address checks; this is a different enforcement mechanism and was not replayed against DNS changes or malicious service workers in this audit. Do not extend the HTTP-probe result into a guarantee for every browser/network path.

Guest engine/tool restrictions, outside-content provenance, memory redaction, and generated interactive-answer sandboxing exist. [OWASP agent guidance](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html) and [prompt-injection guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) call for scoped capabilities and independent approval enforcement. Model instructions alone cannot replace those boundaries. This audit made no live model calls and does not certify resistance to prompt injection.

## Remediation order

1. Fix active stored content and approval path canonicalization; add these exact security regressions to E2E verification.
2. Contain network exposure, enforce pre-auth body/connection budgets, and patch the directly exposed dependencies in every relevant lockfile.
3. Repair transactional file deletion, ingestion acknowledgement and operation idempotency together so recovery cannot lose files/messages or repeat work.
4. Add cancellable deadlines and fix long-running listener teardown; harden pairing, error classification and headers.
5. Verify the actual production/deployment boundary: remote HTTPS and access restrictions, Vercel deployed versions/WAF/spend protection, backup restore, realistic indexed-query performance, provider fault/retry behavior, live-engine consent boundaries and a multi-day heap/socket soak.

## Repeatable verification

From the repository root, after `pnpm install --frozen-lockfile`, with Node 25 native TypeScript transformation:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/security-audit-20261028/loader.mjs artifacts/security-audit-20261028/run.mjs
pnpm exec node --experimental-transform-types --import ./artifacts/security-audit-20261028/loader.mjs artifacts/security-audit-20261028/client-replay.mjs
pnpm exec node --experimental-transform-types --import ./artifacts/security-audit-20261028/loader.mjs artifacts/security-audit-20261028/lifecycle-replay.mjs
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/secrets-at-rest/run.ts
pnpm smoke
pnpm typecheck
pnpm exec tsc --noEmit -p convex
pnpm audit --json
pnpm --dir site audit --json
pnpm --dir pet audit --json
pnpm --dir film audit --json
```

The browser proof uses the default installed Windows Chrome path, or `PERRY_E2E_BROWSER`. Without Chrome, the route/header proof runs but the browser-specific field is null. No browser is downloaded. Each audit script writes JSON; scanner commands exit nonzero when advisories exist, as expected. The credentials harness writes `.batch-work/batch-1/251/e2e-result.json`; this audit copied its result here. Future dependency results will change as registry data changes.

The HTTP replay binds only loopback and starts no engine. Its rollback scenario clears the synthetic scheduler queue before manually ticking it; no queued provider work runs. The client replay substitutes transport only. The current lifecycle replay uses real native idle delays; only the historical baseline accelerated them. Synthetic fault injection is restricted to the disposable database. Temporary HTTP/browser resources and home are removed; the live result records fixture cleanup. The failure inventory was written before these scripts. A completed historical audit check can mean a defect was successfully reproduced: do not treat `completed:true` as `secure:true`.
