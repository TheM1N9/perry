# Failure cases recorded before isolated E2E source
- New saves/imports/patches persist plaintext; double-encryption breaks reads; empty key loses env fallback.
- Login reveal, previews, savedValues/keptSecrets redaction stop recognizing plaintext.
- Unicode/empty/large values fail roundtrip; GCM nonce reuse; wrong table/row ciphertext substitution.
- Missing, malformed, wrong key or damaged/version-unknown envelope silently falls back to plaintext.
- Legacy DB migration partial commit; failure changes unaffected rows; interrupted migration leaves plaintext in WAL/freelist/journal; restart does not retry cleanup.
- Legacy SQLite backups preserve plaintext or overwrite recovery state; migration resumes incorrectly; restore/import cannot read encrypted rows.
- JSON backups contain credential arrays, unexpected formats or symlinks; temporary files leak plaintext.
- Key creation races, truncation, incorrect permissions, loss after encryption, backup-only encrypted state.
- Errors/logs/artifacts expose raw values/key; tests import HOME before isolation or reach live engine.
- Disk full/locked DB/files, invalid JSON, unsupported backup extension must fail closed and preserve original data; successful startup only after cleanup.
- Downgrade reads ciphertext as credential; key rotation without reencrypting historical backups loses access.

Verification scope: disposable full Runtime + actual SQLite + actual backend functions, synthetic values only. Coordinator runs integrated build; no isolated unit tests.

## Follow-up P2 staging failure inventory (recorded before harness edits)
- JSON staging write throws after creating/partially writing the file: original bytes must stay intact, fd must close, identifiable staging must be removed, startup must fail for that attempt and retry must work.
- fsync throws after complete encrypted-only write: identical original-preservation/cleanup behavior; retry must migrate successfully.
- process interruption leaves partial or complete identifiable staging beside an intact original: next bootstrap must discard only staging, re-encrypt the original and finish; never promote unverified staging.
- matching original is absent, invalid JSON, a symlink, a directory or fails credential authentication: preserve staging and fail closed for manual recovery.
- similarly named user files, old ambiguous .json.<hex>.json names, unrelated .tmp files and staging directories: do not delete automatically.
- cleanup itself fails: preserve original, report failure; a subsequent retry may recover the exact staging file after permissions/storage are corrected.
- staging contains a secret/encryption key in error/assertion output or partial serialization writes plaintext: persist only boolean evidence and scan fixture bytes.
- filesystem failure injection must affect only exact staging descriptors in this disposable E2E; restore native Node fs exports before continuing Runtime tests, avoid new production failure toggles.
