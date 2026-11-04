# HTTP attachment sending verification

Issue #339, verified on Windows on 3 November 2026.

The production UI was tested with the existing `artifacts/batch-3/ui-server.mjs`
fixture: separate in-memory database, fresh home, synthetic credentials, stopped
scheduler, remote fetch blocked and child processes disabled. No live engine or
account calls ran. Each browser used a disposable profile.

Both origins passed all 15 assertions:

| Browser context | isSecureContext | crypto.randomUUID | Result |
| --- | --- | --- | --- |
| HTTP Tailscale IP | false | undefined | 15/15 |
| HTTP localhost | true | function | 15/15 |

The assertions covered first-image submission exactly once despite a double
click, a valid UUID v4 message key, another image in the existing chat, distinct
keys, draft/file preservation after an entropy failure, a visible error and
unlocked Send, successful retry, the same preservation/unlock/retry checks for
chat creation and upload failures, text-only sending without browser entropy,
and zero browser exceptions.

The first run exposed a second defect: an immediate first-upload failure could
restore the draft before the new URL's storage key loaded, which erased it.
Navigating after the first send is accepted fixes that race. Navigation is
conditional on still being on the new-chat page so a completed upload does not
pull the owner back from another chat.

Other checks passed:

- Application and Convex TypeScript checks.
- All nine `scripts/smoke.ts` checks.
- Production Turbopack build, with the existing tracing warnings in
  `convex/pet.ts` and `server/wake.ts`.
- `git diff --check`.

The isolated worktree linked installed dependencies. Its build temporarily used
Next's documented `turbopackAdditionalRoots` option; no build configuration change
is part of this patch. A preliminary Webpack build hit Node's default heap limit;
the final acceptance build used the project's normal compiler.

To repeat: build the checkout, start the existing stopped-runtime UI fixture with
a fresh home as documented in `artifacts/batch-3/README.md`, and bind the disposable
server to an address accessible through HTTP. Open it in a fresh browser profile
at both a non-loopback HTTP IP and localhost. Inspect `isSecureContext` and
`typeof crypto.randomUUID`, then exercise the cases above. For failures, reject
`/api/media` or `dashboard:createChat` in the test browser's fetch, or temporarily
make the active browser entropy API throw; restore it before retrying. Count
`dashboard:sendChat` requests and inspect the submitted attachment message keys.

Temporary probes, fixture data and browser profiles were removed after the run.
Existing test sources were preserved. The running installation was not changed.

## Message editing and citation integration, 4 November 2026

Integrated main through `cc6cae5` locally after newer citation handling conflicted
with the submission error boundary. Citation clearing and restoration stay inside
that boundary. Citation IDs also use the HTTP-compatible UUID helper.

Eight targeted browser checks passed on a non-loopback HTTP Tailscale origin:
the editor opens without a page crash; edited words and a new attachment reach
the rewind mutation; edit and upload request IDs are valid UUID v4 strings;
successful save closes the editor; failed first upload preserves the raw draft,
quote and attachment; the error is visible and Send is unlocked; retry sends the
quote and attachment exactly once; and no browser exceptions occur.

The fixture again used synthetic history and a stopped scheduler. Application
TypeScript via the production build, Convex TypeScript, all nine smoke checks,
and the production build passed. The temporary probe and fixture were removed.
This integration was prepared locally; publishing, merging and installation had
not occurred at this checkpoint.
