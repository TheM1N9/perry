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

## PR297 Finder metadata failure inventory (recorded before harness edits)
- A genuine exact-name .DS_Store buddy-container header at the backup root/nested folder blocks normal bootstrap even with intact JSON/SQLite backups.
- Arbitrary plaintext/JSON renamed .DS_Store, a truncated header, wrong magic/version, invalid root range or mismatched duplicate root offset is silently skipped; unsupported content must remain in place and stop bootstrap with a constant content-free message.
- A .DS_Store symlink or directory bypasses regular-file/link restrictions; links must still fail closed and data-bearing directories must still be traversed rather than ignored by name.
- Other unsupported metadata-like filenames, unsupported archives and ambiguous staging are accidentally exempted; preserve existing fail-closed behavior.
- Metadata verification reads an entire large unknown file or emits file content in diagnostics/artifacts; inspect bounded native header only and persist booleans.
- Approved metadata is deleted/rewritten; it must remain byte-for-byte unchanged while actual legacy credentials migrate and stay readable through Runtime.
