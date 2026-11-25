# Pre-fix audit snapshot

These findings describe the implementation before the follow-up changes. See [the fixes and verification report](whatsapp-harness-fixes.md) for current behavior, retained limits and verification. Source line links below refer to that earlier snapshot.

# WhatsApp and harness audit

Audited 2026-11-24 against this checkout, including the uncommitted phone batching change. This is an implementation review with selected isolated reproductions, not a complete penetration test or a claim that every provider behaves identically.

Scope: WhatsApp transport and backend, installed Baileys APIs, contacts, phone approvals, media, MCP, runner and provider adapters, turn admission and recovery, background tasks and workers, computer requests, and API authentication. No real messages, connected-account writes, paid model calls, or commands proposed by a model were executed. Product code was not changed during this audit.

**Evidence labels:** Reproduced means production functions were exercised with an in-memory SQLite runtime or a stand-in permission/connector boundary. Source-confirmed means the path is visible in the implementation but was not exercised against a live service. P1 findings should be addressed before expanding autonomy; P2 findings affect capability, reliability, or clarity.

## Harness findings

### H1 — P1: ACP Ask mode can be bypassed through a display name

**Reproduced.** `AcpEngine.perryTool()` recognizes Perry tools by a regex over the supplied name and title. `onPermission()` automatically allows anything that matches, without requiring it to be an MCP call to Perry's actual server. An execute request titled `echo normal_notes` reached the owner gate and was declined. The same permission envelope titled `echo assistant_notes` was allowed without reaching that gate. No command was executed in this check.

Sources: [classifier](../runner/engines/acp.ts#L898), [automatic allowance](../runner/engines/acp.ts#L940).

Fix: remove display-name authority. Verify tool kind, server identity, and an exact advertised Perry tool name; otherwise use the normal approval path. Fail closed when the protocol supplies insufficient identity.

### H2 — P1: Ordinary connected-account writes lack a server-side consent gate

**Reproduced at the connector boundary.** An Ask-mode owner turn already marked as having read outside content invoked a simulated `AUDIT_SEND_MESSAGE` through the real MCP handler. The stand-in connector executed once and no approval was created. `run_action` passes only slug, arguments, and the bounded-preparation read-only flag. Ordinary turns are not subject to that read-only check. Sending/deleting/publishing consent is described in prose, rather than enforced through an action-bound approval.

Sources: [tool](../convex/tools.ts#L1397), [connector execution](../convex/composio.ts#L603), [standing-change gate](../convex/mcp.ts#L138).

Fix: classify operations from provider metadata, require exact action/arguments/account consent for writes, and recheck it at execution. Unknown metadata must not silently authorize a write. Keep the existing read-only preparation gate.

### H3 — P1: MCP identity is not bound to one turn generation

**Reproduced.** A runner token plus chat ID resolved to the first running turn, then resolved to its successor using the same caller identity. Supplying an obsolete native thread ID alongside the chat ID was also accepted: no thread match falls back to the matching chat. This contradicts the intended rejection of explicit stale identities. A leftover session or delayed tool call can consequently be attributed to newer work.

Sources: [access selection](../convex/codex.ts#L1630), [chat-only transport identity](../runner/engine.ts#L178).

Fix: issue per-turn capabilities carrying runner, conversation, turn, generation, and expiry. Reject conflicting or stale native metadata; retire the capability on Stop, completion, reset, and revocation.

### H4 — P1: Stopped native approvals remain actionable

**Reproduced.** Stop set the active turn's `stopRequested` flag, but its pending approval remained pending. A later WhatsApp `3` approved it and created a lasting approval rule. Approval records have a runner and optional conversation, but no owning turn. Answerability checks status and age, not the original execution's lifetime. This does not prove the stopped command executed; it proves stale approval authority and a persistent grant survived Stop.

Sources: [approval schema](../convex/schema.ts#L1645), [Stop](../convex/codex.ts#L507), [answerability](../convex/approvals.ts#L336), [rule creation](../convex/approvals.ts#L285).

Fix: bind approvals to execution and invalidate pending native/browser grants when that execution ends. Keep durable owner decisions distinct from short-lived execution permissions.

### H5 — P1: Browser approval coverage depends on English labels

**Source-confirmed.** Clicks and Enter submission ask only when a button/input label matches `RISKY`. A consequential control labelled “Continue,” a localized label, or an automatic submission triggered by a selection can fall outside this gate. Browser identity and takeover leases are useful protections, but they do not establish consent for the action itself.

Sources: [regex](../convex/tools.ts#L1208), [click and submission](../convex/tools.ts#L1306).

Fix: use an explicit action policy and exact proposed effect. A label classifier may assist the review but must not be the only reason a state-changing interaction bypasses Ask mode.

### H6 — P1: The MCP route bypasses normal ingress budgets

**Source-confirmed.** The generic HTTP route delegates directly to `runHttp`; the MCP handler parses `request.json()` before it rejects a missing/invalid token. It does not use the size/deadline/concurrency admission applied to ordinary backend calls. The stdio bridge likewise accumulates concurrent relays without a bound or request timeout.

Sources: [HTTP route](../app/api/backend/http/%5B...path%5D/route.ts), [parse before authentication](../convex/mcp.ts#L182), [ordinary limits](../server/api.ts#L15), [bridge](../runner/mcp-bridge.ts#L75).

Fix: reject missing credentials before reading a body, apply streaming size/deadline limits and bounded concurrency, and bound/cancel bridge requests. Reuse `server/request-limits.ts`.

### H7 — P1: Outside-content provenance is incomplete and too coarse

**Partly reproduced.** A stored applied steer containing only “thanks” changed `outwardAllowed` from false to true. This is a broad fresh-owner-message reset, not consent to a particular action. Separately, MCP marks outside reads after execution returns, leaving a parallel read/write window. Owner-uploaded files are attached without automatically setting `outsideAt`; native web-search provenance arrives through traces. Defusing file mentions helps, but does not replace provenance or action authorization.

Sources: [post-read marking](../convex/mcp.ts#L328), [reset by steer](../convex/codex.ts#L1602), [attachments](../convex/brain.ts#L604), [native search](../convex/codex.ts#L909).

Fix: mark untrusted input before exposure, retain its provenance through attachment conversion and parallel calls, and keep action consent separate from a conversational acknowledgement.

### H8 — P2: Persisting a scheduled action does not guarantee its execution

**Source-confirmed.** The runtime removes scheduled actions before running them. A crash after removal can lose that dispatch. Failed scheduled mutations are also removed after logging. Some systems have their own receipts and repair paths, but this is not a universal durable retry mechanism. The new phone buffer survives a restart while pending; the subsequent action handoff still uses this runtime behavior. A surviving preparation reservation can report an interrupted preparation, rather than finish the original work.

Sources: [scheduler](../server/runtime.ts#L325), [phone handoff](../convex/phoneInbox.ts#L27), [preparation recovery](../convex/recovery.ts#L96).

Fix: explicit claimed/completed/uncertain job states, leases, bounded retries, and idempotent side-effect receipts. Do not blindly replay a write whose outcome is unknown.

## WhatsApp findings

### W1 — P1: Inbound receipt handling can lose or repeat work

**Source-confirmed.** `seen` is an in-memory map, and the ID is recorded before download and backend acceptance. A later failure is logged while a redelivery can be suppressed. Restart clears the map. Reconnect history events of type `append` are deliberately skipped. The durable phone batch begins downstream of this gap.

Sources: [early dedupe](../server/whatsapp.ts#L334), [acceptance](../server/whatsapp.ts#L367), [event policy](../server/whatsapp.ts#L491).

Fix: a durable inbox keyed by account, chat, sender, and message ID, with explicit acceptance/processing outcomes. Recover permitted missed messages without automatically answering all historical messages.

### W2 — P1: Queued, sent, delivered, and failed are conflated

**Reproduced.** Finalizing an owner reply set `deliveredAt` while its WhatsApp outbox entry was still pending. After three simulated transport failures, that entry was failed but the turn remained marked delivered. `send_message` to a contact also reports `sent: true` after queueing. No WhatsApp delivery/read-receipt consumer is wired. Outbound sends have no durable protocol message ID recorded before transmission, so a crash or ambiguous acknowledgement can duplicate a send on retry.

Sources: [owner finalization](../convex/codex.ts#L1540), [contact delivery](../convex/contacts.ts#L390), [transport/ack gap](../server/whatsapp.ts#L226), [attempt state](../convex/whatsapp.ts#L318).

Fix: retain a stable outgoing identity and distinguish queued, accepted by transport, delivered, read, failed, and uncertain. Propagate failure to the originating turn/tool. Add paced, bounded retry and an owner-visible retry action.

### W3 — P1: A numeric answer can approve the wrong request

**Reproduced.** With two pending approvals in the same WhatsApp chat, `1` approved the newest and left the first pending. The handler accepts plain yes/no/always too. Incoming quoted context is not passed through as an approval target, so replying to an older prompt does not safely select that prompt.

Sources: [newest-pending selection](../convex/approvals.ts#L693), [owner intake fields](../convex/whatsapp.ts#L429), [transport intake](../server/whatsapp.ts#L367).

Fix: quote-bound approval IDs or short explicit request codes. A bare answer with multiple candidates must ask which one, never guess.

### W4 — P1: Phone approvals can hide part of the authorized operation

**Source-confirmed.** WhatsApp prompts show only 1,500 title characters and 800 detail characters, then authorize the full stored request. Generic command titles can be longer; native permission summaries have a separate 800-character guard, but ordinary commands do not receive equivalent protection.

Sources: [phone truncation](../convex/approvals.ts#L664), [stored request](../convex/approvals.ts#L184), [native permission-specific guard](../runner/index.ts#L658).

Fix: never authorize an invisible tail. Require a complete bounded scope or a secure full preview, and bind the answer to its exact version/hash.

### W5 — P1: Media is downloaded before owner authorization and bounded too late

**Source-confirmed.** Separate-number DMs enter download before `whatsapp.receive` authorizes the sender. The downloader allocates the entire buffer before checking 20 MB. Incoming messages run concurrently without a media-work budget. Download has no shutdown abort/deadline, and shutdown waits for incoming work. The allowed-contact group path has an earlier file check, but the direct owner-routing path does not.

Sources: [download before authorization](../server/whatsapp.ts#L360), [post-download size check](../server/whatsapp.ts#L377), [shutdown wait](../server/whatsapp.ts#L581).

Fix: authorize from the envelope first; validate declared size, stream with a hard byte cap, limit concurrent work, and pass cancellation/deadlines through the driver.

### W6 — P2: The adapter drops substantial native message context

**Source-confirmed.** Owner intake flattens supported messages into text plus attachments. Quoted message identity/content, edits, deletions, forwarded-message provenance, locations, contact cards, polls, and votes do not have complete intake paths. Unsupported types with no recognized text/media are ignored. Incoming mentions/replies help decide whether a group message addresses Perry, but that is not full quoted-conversation support.

Sources: [text/media extraction](../server/whatsapp.ts#L139), [wired events](../server/whatsapp.ts#L491), installed `baileys/lib/Types/Message.d.ts` and `Events.d.ts`.

Fix: preserve a typed message envelope and explicitly acknowledge unsupported content. Add quote/reply and edit/delete handling first, then locations/contact cards and polls.

### W7 — P2: Voice and media remain file-oriented

**Source-confirmed.** Voice notes enter as audio attachments; there is no dedicated WhatsApp transcription and native voice-reply flow. Outbound audio lacks a PTT option and codec normalization. Files have no structured reply/caption/album options. Call events record ringing/active/ended state; that is not a live voice bridge.

Sources: [incoming audio](../server/whatsapp.ts#L156), [outgoing files](../server/whatsapp.ts#L231), [call recording](../convex/whatsapp.ts#L494).

Fix: transcript plus playable original, an explicit text/voice response preference, validated native voice notes, quoted/captioned files, and intentional album handling. Treat live calling as a separate supported integration, not something the current adapter already provides.

### W8 — P2: Baileys recovery and group/identity support are incomplete

**Source-confirmed.** Socket setup omits `getMessage`, a retry-counter store, and `cachedGroupMetadata`. Baileys' installed defaults return no original message/group metadata. Perry caches group names, but does not maintain the native participant cache with group updates. PN/LID normalization uses alternate IDs when present rather than consuming the full mapping lifecycle. Authentication uses the multi-file helper outside Perry's encrypted vault/secrets tables.

Sources: [socket setup](../server/whatsapp.ts#L86), [group-name cache](../server/whatsapp.ts#L271), [ID fallback](../server/whatsapp.ts#L359). [Official retry and group guidance](https://github.com/WhiskeySockets/docs/blob/main/advanced/troubleshooting.mdx).

Fix: provide the original-message store needed for protocol retries and poll decryption; persist identity mappings and maintain group metadata; give device authentication a deliberate atomic storage and protection strategy.

### W9 — P2: Disappearing/view-once semantics are not retained

**Source-confirmed.** The adapter unwraps ephemeral and view-once messages and passes their media into ordinary storage/history/library handling without carrying an expiry or retention flag through that path.

Sources: [unwrapping](../server/whatsapp.ts#L139), [storage](../convex/whatsapp.ts#L462), [attachment persistence](../convex/media.ts#L76).

Fix: preserve the source semantics, avoid automatic permanent archival of view-once content, and expose intentional retention/export choices.

## What to build after the permission and delivery fixes

1. Quote-aware replies and approvals, with request-specific short codes.
2. A phone control surface for status, current task, cancel, retry, snooze, and result previews.
3. Voice-note transcription and an explicit native voice-reply mode.
4. Polls for non-consequential choices, plus structured locations and contact cards. Poll votes must not become generic authorization.
5. Captioned documents and grouped media results that retain their source message.
6. Per-contact/group behavior and quiet controls, refreshed names and membership, and explicit on-demand history search.
7. A delivery/connection inspector showing failures, queue age, retries, receipts, and uncertain outcomes.

The installed library supports quoted messages, polls, locations, contacts, albums, editing/deletion, reactions, and receipt events. Availability still needs to be verified on actual WhatsApp clients. This is not a recommendation to enable broadcast/status/newsletter automation or to assume business-only interactive features work through a linked personal account.

## Verification and next steps

Seven isolated behavior checks produced JSON evidence in tool output: ACP display-name allowance; newest approval selection; a stopped approval creating a persistent rule; stale MCP identity acceptance; the outside-content gate clearing on an unrelated steer; connector execution without approval; and delivered status surviving transport failure. State lived only in memory. The connector was a stand-in and network calls were blocked. No new disposable test files or data directories were created.

The earlier 54 passing E2E checks verify phone batching and task handoffs. They do not cover these adversarial permission, request-correlation, or crash-window cases. Add fault-injection E2E coverage for those boundaries as part of fixing them.

First fix H1–H4 and W3–W4. Then fix H5–H7, W1–W2, and W5. Put capability expansion after those boundaries are enforceable and observable. Keep existing guest lockdown, contact blocking and outbox revocation, scoped worker receipts, bounded preparation tools, and owner-controlled notification limits; those protections should not be weakened during the refactor.
