# Approved account workflows after outside reads

An owner-requested account workflow should continue after reading outside evidence. A read does not authorize a new action or expand the owner's scope. Explicit consequential-action approvals, site-scoped saved logins, browser confirmations and read-only autonomous preparation remain in force.

Failure inventory, recorded before implementation:

- A connector action or saved-login tool is still refused solely because this turn read outside data.
- Removing that refusal accidentally leaves connector calls forced into read-only mode.
- A source loses its untrusted marker, outside timestamp or downstream memory provenance.
- A source can rewrite About me, identity, pinned context, scheduled prompts, contact-sharing instructions or a delegated task's instructions.
- Autonomous preparation gains account-write access; misleading read-like names or missing/conflicting provider metadata bypass its restriction.
- Browser approval creation, decline or site-scoped secret checks are changed or bypassed.
- An unread turn or a new owner reply is incorrectly blocked.

Verification uses the existing internet-routing harness with synthetic public-source and connector fixtures through the real SQLite runtime, MCP endpoint and Composio SDK. It does not use live credentials, send real messages, generate paid assets or run another model. Record the result outside the checkout; remove disposable compiled files after verification and preserve existing test source.

Release: the local patch is reviewable before any repository publication, merge or running-package update. Those actions retain their applicable confirmation boundaries.

## Verified on Windows, 11 November 2026

- `pnpm typecheck`: passed.
- `pnpm exec tsc --noEmit -p convex`: passed.
- Build the existing harness with `pnpm exec bun build artifacts/internet-routing/run.ts --target=node --packages=external --outfile=artifacts/internet-routing/run.mjs`, then run `node artifacts/internet-routing/run.mjs`: all 17 checks passed, exit 0.
- The baseline reproduced the saved-login and account-continuation refusals before the runtime patch. The final run verified actual synthetic saved-login retrieval and exactly one synthetic account write after an outside read. Read-only autonomous preparation rejected the same write.
- Untrusted source markers, tool-origin memory, blocked profile-preference promotion, pending/declined browser confirmation, public-browser isolation, cancellation and connector account/schema checks passed.
- Windows browser shutdown needed asynchronous fixture removal; the final run cleaned up successfully. No installed browser or owner profile was changed.

The harness uses deterministic fixtures and the real runtime/SDK, with no live account writes or model turn. It does not establish live connector health or prove a model's resistance to every hostile source. No production build, running-package update or release occurred during local verification.
