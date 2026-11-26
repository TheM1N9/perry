# Automatic Brain saving: failure inventory

Written before implementation or the isolated replay.

- Ordinary owner facts or pages wait for permission instead of saving.
- Imported preference-like text creates a blocking Brain approval, or is silently promoted to the owner's standing instructions.
- Repeated imported reference saves duplicate facts, replace an owner preference, or escape their project/chat scope.
- The remember tool inherits global scope from an owner's superseded preference before the backend demotes an imported instruction to reference data, leaking a project reference into other chats.
- An imported instruction with the same words as an owner-core memory deduplicates into the owner's row and falsely confirms it instead of retaining unverified provenance.
- An imported edit to About me or a pinned instruction page waits for approval instead of being retained as reference data.
- Full-access Riff replacements still require Accept, lose undo history, retain a stale proposal, or overwrite a concurrent owner edit.
- Ask-mode Riff loses its explicit review behavior when Full access is enabled elsewhere.
- Secret redaction, guest isolation or persistence after reopening SQLite regresses.
- Scheduled summary/Lately saves are blocked after reading source material, or lose their unverified provenance.
- A multiline imported save creates several blocks, but only one row gets tool provenance; a redaction notice is lost when About me redirects to reference data.
- A scheduled project job supersedes a globally visible fact with a project-only replacement, hiding it from other chats. Reject incompatible scope before superseding, and allow an explicit shared-scope correction.
- Reading a saved imported reference through Brain tools fails to mark the turn as outside-derived, so a later summary or Lately save loses provenance.
- Verification invokes a real model, sends a message, writes to the installed home, leaves a runtime alive, or reports setup as acceptance.

Use the actual registered runtime handlers and native SQLite in a disposable home,
without starting the scheduler or an engine. Preserve a bounded result artifact
and remove the fixture home normally. This proves backend save and approval
contracts; it does not prove that a live model chooses to call a memory tool.

## Acceptance

The original handlers saved the owner preference, then failed the imported
reference case by creating a pending proposal instead of saving. The repaired
journey passed 19 checks: owner/reference saves, provenance-compatible deduplication, instruction/data
separation, About me preservation, project scope, immediate Full Riff edits and
history, stale revision refusal, Ask review, no pending save approvals, Lately
provenance, guest isolation, tool-level project scope and SQLite restart persistence. No network/model
was used; the final fixture home was removed normally.

Review replay reproduced a multiline imported save with only one tool-origin
row. Every created block now receives provenance and metadata, and the receipt
keeps the earlier redaction notice. Project jobs cannot supersede a shared fact
into a narrower scope; an explicit shared-scope correction saves without asking
permission. The authenticated MCP routing replay separately verifies that a
fresh turn reading a saved imported page marks its summary and Lately output
as unverified/tool-origin.

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/memory-capture/automatic.mjs "$env:TEMP/automatic-brain"
```

CI retains `result.json` alongside the Full-access approval replay on each OS.
