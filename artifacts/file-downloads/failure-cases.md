# Download format failure inventory

Recorded before changes and the native replay. Use synthetic files, a fresh SQLite home, the production server and Chrome downloads; do not access live owner files or accounts.

- Stored chat attachments download under opaque storage IDs, losing their original filename and extension.
- Stored PDF previews initiate a binary download instead of showing the document.
- Browser downloads saved under GUID paths retain their suggested name but lose their PDF or Office MIME type when registered in the Library.
- Repairing an older Library MIME type leaves its workspace kind index stale, so the file stays missing from the corresponding Files filter.
- Prototype-like filename suffixes such as `.constructor` resolve to inherited object properties and break registration or startup repair.
- A descriptive Library label replaces a physical file's extension on Library or workspace downloads, or during sharing.
- A stored Library snapshot loses the source suffix when its display label has none, despite retaining the original path as metadata.
- A valid suffix outside the MIME table, such as `.py`, is dropped from a labelled download or replaced by the label's unrelated format.
- Correcting metadata changes, truncates, or re-encodes file bytes, including binary and large streamed files.
- Unicode names, spaces, punctuation and compound suffixes are lost or create invalid response headers.
- The Library's label-length limit truncates a browser-suggested filename's known extension.
- Truncating a long Unicode label splits a surrogate pair and makes response-header encoding fail.
- Downloads expose unregistered, removed, other-runner, or unauthorized files; previewing HTML or SVG executes active content on Perry's origin.
- Range and HEAD responses regress, or a missing file produces a saved error document masquerading as the original file.
- A failed replay leaks its temporary database, servers, Chrome processes, download folder or browser profiles.

Each run must write repeatable JSON evidence and native downloaded files for comparison. Inspect and remove disposable outputs after verification; preserve the maintained replay.
