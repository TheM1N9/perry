# Native download verification

The existing native SQLite/HTTP Library lifecycle replay also passed **50/50 checks**, including four added labelled-file and stored-snapshot sharing checks. It preserves remote-runner boundaries and immutable stored bytes. Regenerate it with `pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/library/lifecycle.mjs <output-directory>`.

Automatic approval review blocked deletion of its two reviewed output folders, `node_modules/.cache/file-downloads-lifecycle` and `node_modules/.cache/file-downloads-lifecycle-final`. They remain; deletion was not retried.

Verified on Windows with installed Chrome on 2026-11-27 against production build `979bd2f8-a784-4ea6-a78c-dee0a05efff5`.

The final replay passed **52/52 checks**. It used a new SQLite home and synthetic documents; no owner file, account, phone message or model turn was used. Every requested file downloaded through Chrome with its expected filename and byte-identical SHA-256 hash. Screenshot review confirmed the original name, a reachable Download link and a rendered one-page PDF. Native PDF delivery and inline headers passed in both the earlier 48-check run and the final expanded run.

Verified paths and controls:

- Stored PDF, XLSX, DOCX and a 131 KB binary ZIP preserve original names, Unicode, apostrophes and parentheses. PDF preview is inline; explicit downloads remain attachments.
- Library and workspace descriptive labels retain physical suffixes, including a Python file whose MIME remains generic. A stored spreadsheet snapshot uses its origin's suffix while serving immutable stored bytes even after that original file changes.
- Perry's actual browser downloads a local PDF into its GUID folder, registers PDF MIME and preview metadata, and exposes a correctly named, unchanged Library download.
- A legacy browser PNG and its stale workspace kind are seeded before cold startup. Metadata repairs make the image available in the workspace Images filter. Unknown `.constructor` suffixes do not crash registration or reconciliation.
- A long emoji-containing filename retains a `.pdf` suffix, stays within the 200 UTF-16-unit limit and contains complete Unicode code points. Its download returns valid original PDF bytes.
- Missing/wrong authentication, removed/unregistered attachments, missing files and other-runner local paths are refused. Active HTML remains a download with `nosniff`. Byte ranges preserve exact partial data; invalid ranges are refused. HEAD has no body and retains the filename; this Next.js response omitted optional `Content-Length`, including with identity encoding.

The earlier build reproduced opaque storage-ID filenames, missing stored PDF previews, lost format metadata on Perry's browser GUID files, and extensionless label downloads. Its initial native PDF byte observation accidentally selected a different `downloads.htm` file beginning with the `Cr24` extension-package signature. The request URL was not captured, so its origin and trigger are unknown; it is not evidence that Perry changed PDF bytes. The replay now waits for a newly saved file matching the requested content hash and asserts its filename independently. Missing or altered bytes time out and fail. No claim is made that Chrome performed no background network activity.

An intermediate fixture preseeded the labelled spreadsheet under Perry's automatically discovered files folder, so it already had a different Library name before explicit registration. Moving fixture inputs outside that folder makes the custom-label case deterministic. The initial strict HEAD-length check was also corrected to accept a legally omitted length while checking any declared length and empty response body. The final source and replay passed together.

Run the README command to regenerate `result.json`, the preview screenshot and native downloads. The final run removed its synthetic home and owned Chrome/server processes. After review, automatic approval review rejected deletion of `node_modules/.cache/file-downloads/baseline`, `current`, `final` and `final-snapshot` as blocked by policy. Those four disposable output directories remain. Deletion was not retried through another tool or path.
