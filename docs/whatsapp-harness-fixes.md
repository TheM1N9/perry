# WhatsApp and harness follow-up

Reviewed the owner's WhatsApp history from November 17–24, 2026 read-only, plus representative generated briefs, revisions, research scripts and outputs under `W:\reel-work`. No live messages were sent and no live conversations, credentials or generated files were edited.

## Evidence from the week

- Scripts repeatedly lost audience, source-transcript, runtime and draft-before-upload requirements. Later worker briefs sometimes contained the missing context, so the failure is also in context handoff and review.
- A completed story was proposed again because the check compared recent titles rather than the underlying story.
- A studio result was described as checked white before its beige color was acknowledged.
- A Drive failure was described as a sharing restriction before checking the intended connected account.
- Perry described its own 20 MB download cap as WhatsApp's limit and suggested sending a document, which would not bypass that cap.
- Five failed live outbox records included oversized video/ZIP files; some replies claimed delivery or continued monitoring without a confirmed outcome.
- `vivek-hitrate-20261124/data/scripts/compute.py` resolves inputs relative to its own folder, but its expected `hk_rows.json` and `peers` inputs are absent there. The script also assigns a missing post's date from its neighbors and includes that inferred date in its calculation. The delivered copy cannot currently reproduce the result from its declared paths. This review did not run research, paid API calls or publication scripts.

## Verification failure inventory

Before writing the temporary verification harness, cover these ways the system can fail:

1. A tool title impersonates a trusted MCP tool and skips Ask access.
2. An old turn's grant reaches a successor or sibling chat; malformed or oversized requests are parsed before authentication; concurrent tool waits starve owner controls.
3. Stop, completion, review or Full-access changes grant a stale approval or create an Always rule. A phone prompt hides part of the approved operation.
4. Two phone approvals consume the wrong response, a quote selects another request, a forwarded approval executes, or a replayed wire message settles a later approval.
5. Outside reads race standing changes, attachments lack provenance, or an unrelated steer clears provenance.
6. A connected write executes without exact approval, an account is guessed, or missing metadata authorizes a write.
7. A burst splits, reorders, duplicates or crosses chats; restart loses accepted input; stop/pause revives it; intake failure is acknowledged and lost.
8. Queueing counts as delivery, re-finalization sends twice, retries change protocol IDs, receipts regress, or failures disappear from work status.
9. Unauthorized, view-once or disappearing media is downloaded or archived; limits apply after full buffering; a download never ends or survives shutdown.
10. Auth migration loses/corrupts keys, falls back after decrypt failure, leaves plaintext, fails mid-batch, or logout resurrects credentials. Protocol retry data is unbounded or loses binary values.
11. A scheduled action is lost after claim, replayed with unknown side effects, or fails without a durable, inspectable outcome.
12. Quoted text, locations, contacts, polls and lifecycle updates are confused with fresh instructions, while unsupported audio/call capabilities are claimed as working.

Use an isolated production server, fake transports and fake ACP engine. Preserve a sanitized result ledger and repeatable commands here; remove disposable test code and output after inspection. Existing project tests remain intact.

## Implemented

### Authority and execution

- MCP credentials are issued for one claimed turn and stored hashed. A stopped/completed turn, an obsolete native thread or a conflicting chat cannot borrow another turn's access. Native transports reload their tool configuration when the grant changes.
- ACP permission decisions no longer trust tool display names. Native approvals carry their owning turn; stop/completion invalidates pending decisions and prevents late Always rules.
- Connected operations use verified provider metadata and an exact owner/toolkit account. Multiple accounts require explicit selection. Writes require approval of the account and complete arguments, including under Full computer access. SDK retries are disabled for these calls.
- Phone approvals carry request codes and quote correlation. A bare response cannot select the newest of several requests. WhatsApp waits until every prompt part has been sent. Long scopes are split using existing channel utilities rather than hidden behind preview truncation.
- Ask-mode browser mutations are gated by action, independent of English labels. Outside provenance is recorded before reads and for attachments; an unrelated owner steer cannot clear it.
- MCP authenticates before JSON parsing, bounds streamed input to 2 MB, admits at most eight concurrent calls, and has a separate budget from owner controls. The stdio bridge also bounds lines, concurrency and wait time.
- Scheduled actions retain a failed or uncertain outcome after failure/interruption. Unknown side effects are not blindly replayed. Work status and the board surface these records.

### WhatsApp

- Incoming envelopes are encrypted, durable and deduplicated by account/chat/message. Accepting owner input or dispatching allowed contact input commits with its receipt. Startup recovers pending intake. Recent owner catch-up messages are recovered; old history and recovered control words cannot execute commands or approvals.
- Outgoing protocol IDs are reserved before sending. Queueing, transport acceptance, delivery/read receipts and uncertainty are distinct. Turn finalization cannot queue the same result twice. A self-chat media echo is recognized even before the send callback returns.
- Transport failures appear on the turn, board and work status. A completed batch with failed/unconfirmed items sends one owner-facing notice; it does not silently claim that files arrived.
- Media authorization precedes download. Declared oversized files are rejected before fetching; real downloads are bounded while streaming and cancelled on timeout/shutdown. The default WhatsApp limit is Perry's own **128 MB**, configurable downward with `PERRY_WHATSAPP_MEDIA_MB`. Uploads and runner transfers share the 128 MB ceiling; runner downloads stream to disk. This also removes the separate 50 MB upload and 64 MB runner bottlenecks. Sending a document does not bypass Perry's limit.
- Quotes, forwarding, locations, contact cards, poll descriptions and lifecycle metadata remain explicitly marked reference data. Edits/deletions update or remove messages still in the quiet-window buffer.
- Consecutive images/videos use native albums in groups of up to ten. `share_file.delivery` supports captions, a same-chat `replyTo`, and validated Opus Ogg voice replies. Other voice codecs must be converted before requesting PTT delivery.
- Owner voice notes use the existing local Whisper implementation in an isolated process, with a playable original, persisted/reused transcript and stop/timeout teardown. This requires ffmpeg and an already downloaded local model. It does not enable paid cloud transcription or model downloads automatically. Automatic transcription is bounded to 25 MB/ten minutes; unsupported audio is retained with an honest explanation.
- Original-message retry records retain their native key/body in an encrypted cache bounded to 500 records/24 hours. Native PN/LID mapping uses the encrypted signal-key store. Auth migrates atomically from legacy files and removes plaintext only after a verified encrypted commit; corrupt credentials fail closed.
- Disappearing/view-once content, including content nested inside a quote, is omitted before durable intake/protocol caching. It is not silently converted into a permanent attachment.

The audit's missing retry-cache observation needs qualification: the installed Baileys runtime already supplies bounded retry counters. Those defaults and native fresh group-metadata lookups are retained instead of adding another cache.

### Scripts and workers

Task briefs stay verbatim, retain a source-conversation link and inherit the project workspace. Repeated identical admission from one turn returns the existing task. Worker instructions now require recovering source material and owner corrections, checking shipped/rejected work, inspecting actual deliverables, preserving runnable input/output paths, and separating inferred data from measurements. Paid/long-running scripts must persist results and assets per item and resume unfinished work. These improve the harness contract; they do not guarantee a model's writing taste or factual judgement.

## Operational limits

Live WhatsApp voice/video calling still requires a separate media bridge. Encrypted poll votes without usable original-message context are reported as unavailable rather than guessed. Guest/group isolation remains intact; a group does not inherit the owner's private chat history.

Restart both Perry's server and runner after deploying this change so they agree on turn-scoped MCP credentials. This worktree was tested in isolation; the live Perry service and its conversations were not restarted or modified.

## Verification ledger — November 24, 2026

`pnpm run build`, `pnpm run typecheck` and `git diff --check` passed. The final isolated runs passed **115 behavioral checks**, plus a real local speech-transcription smoke check. Counts below describe distinct final checks, not repeated attempts.

| Run | Passed | Reproduction and observed outcome |
| --- | ---: | --- |
| Phone bursts | 28/28 | Send bursts through fake WhatsApp/Telegram transports into the production server and runner. Check ordering, deduplication, quiet-window batching, silent `NO_REPLY`, attachments, stop/pause, restart recovery, bounded buffers and active-turn steers. |
| Task handoffs | 26/26 | Exercise the existing handoff scenarios with the fake ACP engine. Verify complete verbatim task briefs, closure, source links and resume. |
| Permission, delivery and media boundaries | 36/36 | Spoof a trusted tool title; submit invalid/stale grants and oversized streamed MCP bodies; stop pending approvals; replay/quote phone decisions; read outside context then steer. Inject send failures, uncertain sends, receipts and self-chat echoes before send callbacks. Check privacy, catch-up, edits/deletions, albums, captions, quotes, voice-note delivery, transcript reuse and stopped transcription. |
| Connected accounts and writes | 12/12 | Use the real connector SDK against a local stand-in with two owner accounts and a foreign account. Verify explicit selection, metadata failure, preparation restrictions, exact write approval under Full access, no retry after ambiguous writes, stopped approval rejection and idempotent task admission. |
| Auth and scheduler faults | 9/9 | Use native SQLite with external fetch disabled. Migrate native binary credentials, restart, inject a transaction failure, corrupt an encrypted value and log out. Verify encrypted atomic persistence, no plaintext fallback, retained failed actions and uncertain interrupted actions without replay. |
| Large transfers | 3/3 | Upload an actual 70 MB file through the production route and receive a 70 MB fake WhatsApp attachment through the real runner. Verify both former 50/64 MB bottlenecks are removed and the engine receives the complete file. |
| Same-second edits | 1/1 | Emit two distinct edits with the same original message ID and timestamp while buffered. Verify the final edited text reaches the turn. |

The separate speech smoke check generated local synthetic speech, converted it to Ogg with ffmpeg, and ran the real worker against the existing cached Whisper model. It exited successfully and transcribed: “Check the project files before writing the script.” The model cache was read-only.

The initial harness runs exposed fixture and integration problems, including native resume-grant capture, connector account response shape and an unwanted change to the raw task brief. These were corrected before the final runs above. Failed preliminary attempts are not counted as passes.

Existing repeatable fixtures are preserved in `artifacts/engine-acp/harness.ts`, `artifacts/engine-acp/fake-agent.ts`, `artifacts/whatsapp/fake-driver.mjs`, `artifacts/task-handoff/run.ts`, and the connector stand-ins. Baseline commands, after a production build, are:

```powershell
pnpm exec bun artifacts/task-handoff/run.ts <temporary-output-directory>
pnpm exec bun artifacts/whatsapp/run.ts <temporary-output-directory>
```

The additional fault scenarios used temporary extensions of those fixtures, separate SQLite homes, fake channel transports and fake engine responses. This ledger retains the tested inputs, outcomes and counts. Existing project tests and artifacts were preserved. No real WhatsApp sends, connected-account writes, paid model calls, live credential changes or live-service restarts were used for verification. Real-provider reconnection and live calling were not tested.

Cleanup of `artifacts/.whatsapp-harness-check/`, the two task-created `perry-wa-auth-check-*` homes, one abandoned `perry-phone-bursts-*` home and the two `.harness-*.log` files was attempted after validating the target paths. Automatic approval review rejected the deletion command with “blocked by policy.” These disposable files remain; the rejection was not bypassed.

### Pre-merge CI fixture compatibility

Existing E2E fixtures now claim native turn grants when calling MCP and bind chat approvals to an active turn. The upload rejection probe uses the shared transfer limit plus one byte. Guest replays explicitly dispatch committed intake while their scheduler is stopped, and the owner reaction replay flushes the quiet-window buffer. The file-delivery replay verifies that an ambiguous send is not retried and a late receipt resolves its reserved message ID.

Local reruns passed all 18 job-file delivery cases, seven Scroll cases, 28 security replay checks, 15 guest-file cases, ten guest-reaction cases and 20 inherited-access cases. Existing orphan-task, worker-webhook, streaming, file-rendering, client and Telegram lifecycle replays also passed, along with `pnpm test` and all nine smoke checks. These are existing regression suites adapted to the changed contracts; no new unit tests were added.
