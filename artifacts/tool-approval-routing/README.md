# External tool confirmations

The follow-up native computer-permission repair is documented in
[`../computer-control/full-access.md`](../computer-control/full-access.md).
The current harness has 35 checks, including startup/resumed Full-access
instructions, native grants, interruption, access changes and browser policy.

When an external MCP tool requested confirmation, the Codex adapter normalized it as `tool_user_input`. The runner only handled command/file requests and immediately declined everything else. A synthetic end-to-end replay reproduced that exact path before implementation.

The repair records a distinct `tool` approval and shows it through Perry's existing dashboard/pet/phone approval surfaces. It waits for an explicit owner decision, including in Full and Auto chats. Saved command/file rules and Always allow cannot supply tool consent. Approvals remain tied to their originating chat. Native declines return the MCP decline result; expired backend rows resolve the runner's wait loop. Requests from stopped/replaced turns are cancelled rather than accepted by a late reply.

Only confirmation forms with an empty object schema are supported by this repair. Forms requiring user-entered fields, URL flows, identity verification and unknown schema constraints return a clear unsupported-input error. Their answers are never invented. Perry's own MCP tools retain their existing gating. Reviewer threads cannot request tool consent, and guest chats cannot create owner tool approvals.

The installed Codex protocol was generated locally with `codex app-server generate-ts --experimental`. No connected account was queried or changed. The specific historical GitHub denial event was not recovered, so this proves the repaired approval path rather than a completed live GitHub issue creation.

Repeat the synthetic protocol/backend journeys:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/tool-approval-routing/e2e.ts W:/perry-qa/tool-approval-routing-20261023/fixed
```

This uses the production Codex adapter, the actual runner dispatcher and wait loop extracted from `runner/index.ts`, production approval handlers and disposable SQLite. Extraction avoids starting an installed runner on import. The app-server transport is fake, and network is blocked. Results: 22 passing workflow checks. The original baseline failed 11 of the first 12 scenarios.

Production UI/API checks (own server, browser profile and synthetic approval records; no runner or engine is started):

```powershell
pnpm run build
pnpm exec bun artifacts/tool-approval-routing/app.ts W:/perry-qa/tool-approval-routing-20261023/app
```

The UI run checks pending display, keyboard approval, mobile controls, decline, removal after answering, absence of Always allow, no browser errors and no model turns.

Validation completed: production Turbopack build and TypeScript passed, all 22 protocol/backend cases passed, all 8 production UI/API checks passed. Desktop and mobile screenshots were inspected. The first UI fixture omitted the native Enter character in its CDP keyboard event and timed out; the corrected native event completed all checks against the same frozen build. The earlier Webpack build exceeded its heap budget; validation used the standard build with a local dependency tree. Two existing dynamic filesystem tracing warnings remain in pet.ts and wake.ts.

Existing checks run for this repair: turn health 22, structured turn errors 21, task steering 62, trace settlement 51, Windows smoke 9. The unrelated `runner/engines/claude.ts` modification in the owner's original checkout is preserved.

Total: 195 passing correctness checks (22 + 8 + 165). No push, PR, merge, installation or runner restart was performed. The issue and PR descriptions here are local drafts. Activation requires the running dashboard and runner to be updated together.
