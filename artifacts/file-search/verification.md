# Sidebar Files search verification

Verified on Windows with installed Chrome on 2026-11-27 against production build `5ea42a8c-4853-4f63-8d07-9df3d0f38e2c`.

The final maintained replay passed **31/31 checks**. It seeded 138 workspace memberships, including 60 initial filler files and 70 later matching files. Case-insensitive multiword search found a target beyond the first page. Matching-result pagination returned every expected scoped ID once, and hidden, type, working-file, chat/project and contact boundaries remained effective. A descriptive label could also be found using its physical download suffix.

Two native Runtime/SQLite query probes temporarily observed the real filesystem API without replacing its result: nonmatching names and rejected contact sources caused zero `realpathSync` calls. The sparse `working:false` no-match query decoded 137 membership rows from 138 total seeded memberships, demonstrating bounded native membership batches rather than repeated full-prefix hydration. Observers were restored in `finally` before the production server started.

Production Chrome checks exercised typing, a matching group saved as collapsed, the actual text-file preview and Back control, clear with focus retained, cursor reset after browsing a later page, Escape, Enter, working-file search, empty results, and project/chat scope changes. Desktop and 390 × 844 screenshots were inspected. The mobile search field remained at least 16px and the panel had no horizontal page overflow. Chrome reported no uncaught page exceptions, and keyboard use created no model turn.

The first production replay passed 26 checks and an expanded replay passed 28 before the filesystem-order and query-limit review fixes. The final replay added the native access/performance probes and passed against the rebuilt source. This is a Chrome viewport check, not a physical-phone keyboard test or an hour-long resource soak.

Run the README command to regenerate incremental JSON evidence, a bounded server log and the desktop/phone screenshots. All runs removed their synthetic SQLite homes and owned Chrome/server processes.

After review, automatic approval review rejected deletion of `node_modules/.cache/file-search/current`, `node_modules/.cache/file-search/final` and `node_modules/.cache/file-search/final-reviewed` as blocked by policy. Those report folders remain. Deletion was not retried through another tool or path.
