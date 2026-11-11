# Native upload verification

Verified locally on 12 November 2026 on Windows 10.0.22631 x64, Node 25.8.2 and Bun 1.3.8. No real storage writes, paid calls, service changes or review submissions were used for these checks.

## Transfer and access checks

A disposable HTTP storage fixture received and compared the actual streamed bytes, including Content-Length and conditional PUT headers. Its 14 scenario groups passed:

- Exact bytes, persisted receipts and retry skipping completed PUTs.
- Transient 503 retry, bounded to three attempts.
- Lost response after a committed PUT, recovered by signed HEAD without another PUT.
- Existing wrong content rejected; an unverifiable 412 remains incomplete.
- Whole-manifest rejection before transfer for missing files, wrong sizes, HTTP URLs, foreign takes, duplicate keys, extra headers and mixed buckets.
- Expired links refreshed with the same reservation identity, including after a partially completed batch.
- Refused signatures request new links; redirects are not followed.
- Same-size local content changes cannot reuse a completed receipt.
- Cancellation releases the active-batch lock; concurrent duplicate calls cannot transfer.
- Malformed manifests fail without network access; receipts contain no signed URLs.

A second fixture used the actual authenticated MCP HTTP handler, production module registry and an isolated SQLite runtime. All six scenario groups passed: owner discovery of the path-only tool schema, owner invocation reaching native validation, outside-content hold, guest exclusion, read-only preparation exclusion, and stop/pause rejection before transfer.

Both fixtures were compiled with `pnpm exec bun build --target=node` and executed with Node, matching the production backend runtime. The disposable scripts, bundles and scratch data were removed after verification as AGENTS.md requires. Direct Bun execution was not used to establish production transport compatibility.

`pnpm run typecheck`, `pnpm run smoke` (all nine checks) and `git diff --check` passed. The smoke service check was a dry run, not a service installation.

## Channel Desk integration

The companion change adds a signed HEAD `verificationUrl` for each file returned by `create_upload`. The existing official MCP client integration verifies those keys and confirms that refreshing the same request preserves the upload ID and object keys. It continues through normal finalization. Existing organization and storage boundaries remain in place.

On Channel Desk main at a8f3994 plus the companion change:

```text
bun run test:backend -- convex/mcp.test.ts convex/storage.test.ts convex/orgs-review.test.ts
3 files, 16 tests passed
bun run typecheck:convex
bun run typecheck
Both passed
```

## Remaining release proof

`pnpm run build` passed with Next.js 16.4.2 Turbopack, including TypeScript and all 37 static pages, again after rebasing the implementation onto Perry main at 2d2bc85. The transfer/access fixtures ran before that rebase; the new upload outward guard was retained alongside main's new task-decision guard. The isolated W: checkout shares its dependencies with the existing C: checkout. A temporary `experimental.turbopackAdditionalRoots` entry pointed only at that dependency checkout for this check; it was removed afterwards and is not part of the feature. Earlier webpack attempts failed because of the cross-drive junction, memory pressure and insufficient disk space. No generated private-data traces from those attempts were retained.

The first real upload remains the already-created Pepsi v3 reservation; its file bytes have not been transferred. Release and activation have not happened. A successful local receipt alone is not a submitted review version: finalization and a review-status readback remain required.

Single PUTs restart the interrupted file; this is not multipart byte-range resumption. Recovery of an uncertain committed PUT needs Channel Desk's signed HEAD URL. Production storage and live review behavior remain unverified until that first approved upload.
