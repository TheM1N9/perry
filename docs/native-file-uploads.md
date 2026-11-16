# Native file transfers

Perry's local backend receives the exact file paths and signed PUT reservation returned by Channel Desk. The transfer tool streams those files to storage, saves receipts without signed URLs, and reports whether every file arrived. The existing Channel Desk MCP remains responsible for creating the take, refreshing its reservation and finalizing the review version.

## Contract

`upload_files({manifestPath})` reads a local JSON manifest containing a stable request ID, the take and upload IDs, the signed reservationProof, and the local paths, sizes, types, keys, signed URLs and required headers. Keeping links in that local file avoids repeating signed credentials in tool arguments. Only the owner's active, writable turns receive it. It is an outward action, never a preparation or guest tool. Existing owner approval can continue after outside reads under #358; outside content cannot authorize a transfer.

All files are checked before any network transfer. Only HTTPS AWS-signed Cloudflare R2 PUT URLs for the same account, bucket and take reservation are accepted. No cookies, saved credentials, redirects, arbitrary HTTP methods or caller-selected state directories. The tool checks local regular files, hashes their contents and binds its receipt to that exact manifest. It never logs or returns the URL query.

Receipts are scoped to the conversation and request ID. A repeated call verifies local content. A matching successful receipt can skip an immutable object; a supplied signed HEAD URL also verifies its remote size and ETag. A fresh URL for the same storage key is compatible. An interrupted single PUT restarts that file; it does not claim byte-range multipart resumption. Transient network/server errors get bounded retries. An expired or refused signature returns `needs_fresh_urls`: call Channel Desk `create_upload` again with the SAME request ID and manifest, then repeat `upload_files`. Never create another take or finalize a partial batch.

After `uploaded`, call `finalize_version` with the existing upload ID, script, transcript, title, caption and credits. Read back the returned take/version and confirm it is in review before reporting success. Uploading never publishes or starts QC.

## Failure cases to exercise before implementation

- Missing file, wrong size, directory, duplicate storage key, unsafe path, mixed destination or wrong take: reject before sending bytes.
- Invalid/expired signatures, HTTP redirects, authorization failure, quota/size errors: return a bounded failure without leaking URLs or remote response bodies.
- Server error, connection loss, cancellation, timeout, concurrent invocation, process restart and a response lost after the object committed: resume without duplicate completed files.
- Existing object: verify size and single-part ETag against the local digest before treating a 412 as success; reject a mismatched object.
- Local file changed before retry or during upload, or an existing receipt bound to a different manifest: stop, never silently finalize changed material.
- Successful bytes but interrupted receipt write: recover from the immutable destination rather than overwriting it.
- Guest/read-only tools, outside-content hold and stop/pause cancellation: retain current access boundaries.
- A normal batch produces per-file receipts and can be finalized exactly once; credits and the same take/upload IDs survive.

## Verification

Use an end-to-end HTTP fixture and a temporary receipt directory. The fixture records exact received bytes, forces transient failures and a lost response after commit, checks conditional PUT behavior and HEAD recovery, then requires all expected files before a simulated review finalization. No real storage, account changes or paid calls are used by this fixture. Remove disposable fixtures after the run; keep a concise verification record.

## Release

Implement on `codex/native-upload`. The GitHub connector refused issue creation with HTTP403 (`Resource not accessible by integration`), so no remote issue or PR has been created by this turn. Production activation and the real Pepsi upload remain explicit completion steps, not implied by passing local tests.
