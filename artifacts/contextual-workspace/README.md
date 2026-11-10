# Contextual workspace (#285)

The Files/Work panel is available by default; no rollout flags are required. The Files/Work panel uses the same local bearer-key boundary as the rest of Perry; guest/contact chats cannot open it. Browser view is an optional slot used by #286.

The Library remains the file identity and storage. `workspaceFiles` records explicit membership and source chat/message/run/task, including a task or schedule's recorded origin. `workspaceViews` stores scope-specific pin/hide choices; neither action deletes bytes. Existing proven attachment/Library attribution is backfilled at startup. A folder scan alone cannot create membership. Unavailable registered artifacts retain identity through sync and become ready again when restored. `library_add` supports role, versionOf and versionLabel; versions must use different paths and an explicit previous Library ID. Existing files are not guessed into versions.

Files pages contain at most 50 membership rows, with indexed SQLite pagination. Tree/gallery share the same identities. Image thumbnails use the actual image and lazy loading; videos request metadata and show duration when available, limited by page size. Work reads existing tasks, plans, runs, spans and approval state. It shows up to 25 recent items, expanding to 100; large project work queries are bounded to 100 chats, with the Work page available for history. No fake percentages or planned file placeholders.

Preview delivery checks both the key and selected chat/project membership. HTML/SVG and unknown formats download; text is bounded to 192 KiB and rendered as plain React text; PDFs are sandboxed. Media uses existing range serving. Credential/hidden/cache paths and symlink targets are rejected from workspace views. This is an artifact viewer, not an arbitrary filesystem explorer.

Run the real backend journey against a throwaway home (never use your normal Perry home):

```sh
pnpm exec node node_modules/.pnpm/esbuild@0.27.0/node_modules/esbuild/bin/esbuild artifacts/contextual-workspace/verify.ts --bundle --platform=node --format=esm --packages=external --outfile=.next/workspace-verify.mjs
PERRY_HOME=/tmp/perry-workspace-verification-285 pnpm exec node .next/workspace-verify.mjs
```

Use a fresh directory on repeat runs. `report.json` records completed checks and the throwaway fixture IDs for dashboard inspection. The test covers two unrelated chats, explicit project browsing, version chains, registered intermediates, background routing, share_file, failed/missing files, pin/hide, auth, pagination and reopening SQLite. No model or owner credentials are needed.

For the dashboard/media journey, start the built or development server against the home recorded in `report.json`, with `DASHBOARD_KEY=workspace-verification-key` and `PERRY_PORT=7385`. Then run `pnpm exec node artifacts/contextual-workspace/verify-http.mjs` (requires the host's ffmpeg for real PNG/MP4 fixtures). `http-report.json` records HTTP access, ranges, active-content disposition and missing-file recovery. Use a separate hostname for concurrent test installations because media cookies are host/path scoped, independent of port.

Dashboard evidence includes `desktop-preview.jpg` plus a recorded responsive journey: sidebar keyboard resize, selected-version preview, same file IDs in gallery/tree, explicit project switching, related task outputs, draft preservation and mobile close/focus controls. No real browser sessions or owner files are used.
