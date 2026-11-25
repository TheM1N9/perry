# Typed instruction recovery: failure inventory

## Real-engine manual candidate inventory

Before the temporary manual host was written: a legacy tool name can be absent from discovery; a listed tool can describe direct writes while Riff intercepts them for review; the model can finish without editing and its useful refusal can remain hidden; a title-only replacement can bypass review; an older title proposal can overwrite a later manual title; Accept/Reject/Undo can change the wrong revision; manual input can be lost during acknowledgement, failure or navigation; a host restart can repeat paid requests or lose evidence; a fixture can contact messaging destinations or mutate the installed home; capture can exhaust disk or leave a runner. The host never sends model requests. Root drives each bounded request through the browser, checkpoints its stored result before another request and uses normal isolated-home/process teardown. Completed host runs refuse automatic reuse. The real engine is explicitly distinguished from fake-CLI recovery proofs.

Written before isolated reproduction code, 25 November 2026.

- A typed instruction is acknowledged/cleared, then the real runner's fake CLI fails; the chat records an error while Riff silently returns idle.
- The failed request is neither visible nor intentionally retryable; document text changes despite the failure.
- Queue acknowledgement is mistaken for a completed edit, or a delayed acknowledgement erases newer typing.
- A failure overwrites a newer instruction, or recovery replays a different instruction/selection.
- Leaving/reopening the document loses the only discoverable failure, leaks its browser/server/runner, or performs an automatic retry.
- A synchronous missing-engine refusal is incorrectly treated as evidence for the asynchronous post-acknowledgement case.
- A successful run writes no document/proposal and its useful assistant explanation disappears; a later run shows the previous reply.
- The Riff prompt names hidden legacy tools and the model refuses to use the advertised Brain tools because their description omits native proposal interception.
- A title-only brain_write bypasses Riff review; Reject alters title/body, Accept misses title, or an old proposal overwrites a newer owner title.
- Plain dictation append starts requiring approval, or failed revision checks create proposals on stale content.
- A typed instruction applied as a steer has its own run but no codexTurns row; its exact receipt fails to show the shared parent response or picks another chat's response.
- Reject clears the native proposal, but a subsequent fresh brain_read still cannot tell the model that no proposal is pending; an earlier do-not-repeat response blocks a new explicit owner request forever.
- A definitely unsent editor conflict is misreported as a transport-unknown dispatch and blocks safe repair/resend.
- Newer unsent instruction text survives acknowledgement but disappears on full reload; initial restoration overwrites persisted text, or a late unmounted response overwrites a newer page's draft.
- Denied session storage throws from typing, erases mounted instruction text, or gives no Copy guidance; restored storage cannot resume normal saving.
- A corrupt, wrong-table or deleted persisted run ID fails subscription validation, shows another run's reply, or triggers a fallback send instead of a non-dispatch recovery receipt.
- A dictation acknowledgement arrives after unmount; the old component persists its stale instruction/receipt over a newer page's beta draft. Original voice batch must stay recoverable without automatic or duplicate sends.
- The fixture reaches an installed signed-in provider, downloads an embedding model, consumes real account actions, or leaves an isolated home/profile.

Use one native Chrome profile and the existing production Riff routes/notes operations plus real runner with fake ACP CLI. Guard every signed-in engine; deterministic fixture embedder; preserve at least 200 MB free native C disk. Record acknowledgement timing, actual failed turn/chat state, dock text, instruction field and stored note. This is a focused reproduction, not full Riff acceptance.

## Confirmed baseline

25 November 2026, production build `a0cea20e-035b-427b-8e63-432fa1d52a2c`; the existing real runner used only the fake Grok ACP CLI. The fake process was killed after its logged prompt proved it had received the original instruction. No provider/default response was substituted for engine failure.

The historical command `pnpm exec bun artifacts/riff-v2/recovery-repro.ts node_modules/.cache/riff-recovery-baseline` used native C Temp through `TEMP`, `TMP`, `TMPDIR` and `PERRY_E2E_DIR`. The temporary reproduction script was removed after repair verification under the project cleanup rule; repeatable manual scenarios and final results are in `docs/verification-riff-recovery.md`. The first driver attempt stopped before product interaction at Bun/Playwright CDP attachment; the completed reproduction used the existing native CDP helper directly.

Six of ten checks passed; four failed:

| Check | Observed result |
|---|---|
| Fake-only engine guard | Passed; no other engine signed in. |
| Actual HTTP acknowledgement preserves newer typing | Failed: the real `notes:sendLive` response was HTTP200, held in the browser while beta was typed; delivery cleared the field to an empty string. |
| Actual asynchronous engine failure | Passed: the runner saved an error turn; chat was idle with `lastError: ACP connection closed`, `lastErrorCode: engine_failed` and a concrete `lastErrorRunId`. |
| Stored document unchanged | Passed. |
| Separate newer draft survives subsequent engine failure | Passed after beta was re-entered as an independent control. |
| Owner sees recorded engine error | Failed: the dock contained only the model name. |
| Owner can discover original alpha instruction in Riff | Failed: it appeared in neither document nor dock. |
| Leaving/reopening automatically replays | Passed: no new turn. |
| Reopening retains a visible failure | Failed: dock showed only hotkey/model. |
| Browser exceptions | Passed: zero. |

Result and screenshot were recorded at `node_modules/.cache/riff-recovery-baseline/{result.json,post-ack-failure.png}`. Owned browser/server/runner processes closed; `tempHomeRemoved: true`; native C free space returned to approximately 821MB. The main audit lane separately reproduced the same invisible asynchronous failure without a runner: typed input cleared, note unchanged, chat idle with an actionable offline/sign-in error absent from the Riff page. Neither observation establishes complete Riff acceptance.
