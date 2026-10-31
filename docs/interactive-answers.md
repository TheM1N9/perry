# Interactive answers (issue #282)

## Decision

Extend Perry's chat renderer, MCP tools, SQLite documents and query subscriptions.
Inspection found no widget renderer to preserve. OpenIntelligentUI's [architecture](https://github.com/CopilotKit/OpenIntelligentUI/blob/main/docs/architecture.md)
uses CopilotKit/AG-UI streaming, a separate Python/LangGraph agent, process-memory
checkpoints and independent generated snapshots. Adopting it would duplicate
Perry's engine, streaming, memory and authorization paths. This integration adds
no dependencies, model provider, Python backend or separate event protocol.

Web dashboard first. Telegram/WhatsApp replies must carry the useful text summary;
the agent tool descriptions require this. There are no public artifact links.
The owner may open the original conversation in their authenticated dashboard.
Guest conversations and remote pet credentials cannot reach artifacts.

## Supported contract

`lib/interactive.ts` owns schema version 1. Native calculator: each row computes
`fixed + perUnit * declaredNumberInput`. Tables and bar charts use bounded rows
and columns, null means missing. Cells may reference a declared input, including
dates for a draft calendar. A declared text input named `filter` filters rows
locally. Controls support number, select, date, boolean and text. Common forms
are declared controls with a table. There is no expression evaluator.

Custom answers supply HTML, CSS and JavaScript defining synchronous
`function render(inputs) { return '<p>...</p>'; }`. With no JavaScript, HTML is
displayed directly. Generated JavaScript has no DOM; it computes markup in a
disposable worker inside an opaque-origin iframe. CSS and the resulting markup
are displayed there. `<input data-perry-input="declared_id">` and selects can
update declared state; the native controls are always available too.

State is a validated map of declared scalar inputs, never an arbitrary DOM
snapshot. Definition updates replace the sandbox and preserve only input ids
whose kinds and values remain valid. Definitions and updates are atomic tool
calls: chat work shows preparing/revising while the call runs; the browser then
shows rendering, ready or failed. Partial generated code is never executed.

## Questions for the owner

`interactive_create` also accepts `view: {kind: "question"}`. The existing
declared inputs become a question card: select inputs use radio cards and can
start with `initial: ""` for no preselection; text inputs provide free-form
answers or details. At least one input is required. The owner explicitly
presses Send answer; typing and selecting only save a draft. Perry's standing
instructions ask it to end its reply and wait after creating a question.

The answer mutation validates the full input map, saves the submitted values,
marks the card answered and sends a labeled message to the same conversation
in one transaction. Identical retries return the existing answer; conflicting
answers, stale revisions, and subsequent save/reset/undo/revise operations are
rejected. The normal queue or steering path continues the conversation. Drafts
and submitted answers survive reloads. Question responses carry the existing
outside-content restriction, including steering and requeueing: a clarification
form never grants approval for an external action. Phone channels use text.

Question E2E failure cases: empty/malformed forms and undeclared choices;
wrong key, conversation or guest access; no automatic submission; radio/keyboard
and free-text entry; draft restoration; failed sends preserving inputs;
submission before autosave fires; duplicate/two-tab sends; answered-card
immutability and reload; stale revision conflicts; exact answers delivered
once to the same chat; queued/applied/requeued answers not granting approval;
mobile/reduced-motion layout and browser exceptions. No unit tests are added.

## Persistence and concurrency

SQLite creates the two new document tables and indexes on startup using the
existing additive schema migration. No old rows change. Definitions carry a
schema version; each definition/state/follow-up write increments the revision.
Creation request ids deduplicate retries per conversation. Mutations compare
expected revisions inside the existing transaction; stale tabs preserve their
local edits and offer explicit load-latest or keep-mine recovery. A retry of the
last successful request is idempotent. Older retries fail their revision check.
Stopped/finished turns and late definition updates from older turns are refused.
Only complete validated drafts become visible, so interrupted generation leaves
the previous artifact usable. Reset and one-level undo are durable revisions.

Limits: 20 artifacts and 100 source receipts per conversation, 96,000 characters
per definition, 12 inputs, 200 rows, 12 columns, one previous snapshot. Retention
follows the conversation; deleting a web chat deletes its artifacts and receipts.
No timed expiry loses an owner's draft. Payloads live in the owner's local DB
and backups. Export JSON includes definitions, selected inputs and provenance;
native tables/calculators also export CSV with spreadsheet formulas escaped.

## Provenance and account boundaries

Examples must say illustrative; explicit owner inputs say owner-provided.
Successful MCP `read_page`, nonempty `internet_read` and read-only `run_action` calls return a server-stamped
`sourceReceipt` while the feature is enabled. Retrieved artifacts must reference
receipts from the same conversation and match the exact source and fetch time.
Period, units, assumptions and missing fields remain explicit. These are snapshots,
not live subscriptions. The agent still interprets/transforms source data; a
receipt proves a read occurred, not that its interpretation is correct. External
content keeps Perry's existing untrusted-data wrapper and outside-read safeguards.

No artifact control can execute a connector, send a prompt, or approve a tool.
The host's explicit Ask Perry form queues a targeted **draft** follow-up once per
revision. Its turn starts marked as having read outside content, and reading an
artifact also sets that mark. Consequential connector calls are held server-side
by the existing MCP outward-action gate until the owner approves separately in
a new chat message. This feature adds no side-effect execution/retry subsystem;
the existing action result and approval UI remain authoritative. Failed draft
saves and follow-ups keep the owner's inputs and display failure, never success.

## Sandbox policy

Iframe: `sandbox="allow-scripts"`, no same-origin/forms/popups/downloads/top
navigation or privileged permissions. Nonced trusted bootstrap; no generated DOM
scripts. CSP denies network connections, remote scripts, fonts, media, nested
frames, objects, base URLs and forms; only inline styles, data images and blob
workers are permitted. Markup is parsed in an inert template and stripped of
navigation/resource/event-handler attributes and active elements before mounting.
Workers terminate after 1 second or their first result, capped at 30,000 characters.
The host accepts only messages from the exact iframe window, opaque origin,
artifact id, revision and random mount nonce. Input messages use a strict schema,
2,000-character scalar limit, declared-input validation and a 20-message/second
limit. State sends are debounced; workers are replaced on each calculation.

There is no reliable browser API for a per-worker memory quota. Untrusted code
may exhaust browser memory within its wall-clock limit; code should be small,
and native components are preferred. The host retains accessible text, controls,
JSON export and bounded rendering retry if a worker crashes or times out.

## Rollout and operation

Generative UI is enabled by default. Perry can create and revise interactive
answers through the existing `interactive_*` tools, with no additional setup.
To disable it, set `PERRY_INTERACTIVE_ANSWERS=0` and restart Perry: tools are
absent, reads return no artifacts and writes refuse. Remove that override and
restart to reenable; saved rows remain recoverable.
Reverting code leaves unused additive tables in place. Back up the existing
SQLite database before deployment, using the normal Perry backup procedure.

There are no model calls per input change. Generation/revisions use the normal
engine turn, with its existing token/cost accounting (`generationRunId` references
the creation run). Artifact rows retain first-render timestamp, generation run,
successful revision/save counts, conflicts, restorations and render errors.
Time to useful content can be measured from the run's start to first render;
normal run outcomes provide completion and generation failure rates. No payloads,
input values, secrets or generated source are added to telemetry logs. Counters
measure browser reports, not a guarantee the owner found an answer useful.

## Verification failure checklist

Written before the E2E harness (no unit tests): malformed/oversized definitions;
undeclared, out-of-range or incompatible values; duplicate create/update/save;
stale two-tab saves; wrong conversation/key/guest/public-internal access; canceled
or older turn writes; reload/server restart restoration; compatible/incompatible
code revisions; missing/partial data; forged/missing provenance receipts; foreign
iframe source/origin/id/revision/nonce; unknown/oversized input bridge messages;
network/host-storage access and generated event handlers; worker infinite loop;
render failure/retry/text fallback; draft follow-up duplicate and outbound refusal;
failed write never reporting success; reset/undo/export; keyboard/mobile/reduced
motion; feature disabled; conversation deletion and retention cleanup.

Run `pnpm build`, then use an installed Playwright module and Chrome executable
(test tooling only; neither is added to Perry's dependencies):

```sh
PERRY_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
PERRY_CHROME=/path/to/chrome \
pnpm exec node artifacts/interactive-answers/run.mjs artifacts/interactive-answers/latest
```

It uses a fresh temporary PERRY_HOME, isolated port, fixture web data, simulated
runner reports and real production HTTP/MCP/storage/browser paths. No owner
credentials or real external accounts are used. Result JSON, screenshots and
server diagnostics are the repeatable evidence. Live authenticated connector
and actual engine-selection behavior require separate owner-account validation;
fixture verification must never be described as live connector verification.
