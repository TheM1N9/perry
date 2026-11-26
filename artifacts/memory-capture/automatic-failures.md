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
- Verification invokes a real model, sends a message, writes to the installed home, leaves a runtime alive, or reports setup as acceptance.

Use the actual registered runtime handlers and native SQLite in a disposable home,
without starting the scheduler or an engine. Preserve a bounded result artifact
and remove the fixture home normally. This proves backend save and approval
contracts; it does not prove that a live model chooses to call a memory tool.

## Acceptance

The original handlers saved the owner preference, then failed the imported
reference case by creating a pending proposal instead of saving. The repaired
journey passed 15 checks: owner/reference saves, provenance-compatible deduplication, instruction/data
separation, About me preservation, project scope, immediate Full Riff edits and
history, stale revision refusal, Ask review, no pending save approvals, Lately
provenance, guest isolation, tool-level project scope and SQLite restart persistence. No network/model
was used; the final fixture home was removed normally.

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/memory-capture/automatic.mjs "$env:TEMP/automatic-brain"
```

CI retains `result.json` alongside the Full-access approval replay on each OS.
