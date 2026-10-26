# Full access still asking for computer permission

The user clarified the symptom after the initial browser audit: Perry asks for
computer access while the chat already has Full access.

Two concrete mismatches were found and corrected:

- Codex normalizes `item/permissions/requestApproval`, but the runner had no
  handler for `permission_approval` and silently declined every request. Full
  access now grants the requested native network/filesystem permissions without
  asking. Ask and Auto show the actual request through the existing approval
  surfaces. Switching a pending request to Full releases it immediately.
- Full-access engine instructions used an empty access paragraph. Codex, Claude
  and ACP engines now explicitly tell the model that computer permission is
  already granted and that it should not ask again for general computer,
  browser, app or filesystem access for routine steps in the owner's request.
  Codex startup and resumed instruction payloads are exercised in the harness.

Native grants are limited to the current turn and the requested scope. They
cannot be supplied by saved command/file rules or become an Always allow rule.
An interrupted, stale or replaced turn cannot receive a late grant. The native
decline response now includes the protocol's required `scope: "turn"`.

Perry's own browser already honors Full access; the follow-up E2E checks that it
creates no pending approval. Separate explicit third-party tool confirmations,
authentication challenges and operating-system consent are not computer-access
grants and keep their existing supported flows.

## Verification

```powershell
codex app-server generate-ts --experimental --out node_modules/.cache/perry-computer-control/codex-protocol
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/tool-approval-routing/e2e.ts node_modules/.cache/perry-full-access-fixed
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/computer-control/run.ts
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/parallel-sessions/run.ts
pnpm exec tsc --noEmit --incremental false -p convex/tsconfig.json
pnpm exec powershell -NoProfile -File artifacts/batch-1/run-isolated.ps1 -Mode Build
pnpm smoke
```

The installed Codex 0.163.0 generated contract was inspected before implementing
the response: `PermissionsRequestApprovalParams`, `RequestPermissionProfile`,
`GrantedPermissionProfile`, `PermissionsRequestApprovalResponse`, and
`PermissionGrantScope`. No native app-server or live model was started.

The approval E2E uses the actual Codex adapter, production runner dispatcher and
approval backend/SQLite, with fake native transport. It records 35 passing checks
including the original external-tool confirmation regressions. The prior native
grant baseline failed seven of 29 checks; its result is saved as
`full-access-baseline.json`. The browser and parallel suites pass 19 and 39
checks. `full-access-verification.json` records the final source hashes and
validation. No live model has verified whether it stops asking in natural
language, and the user's exact historical access prompt has not been recovered.

Activation requires updating both Perry's server and runner. These changes have
only been committed in the audit branch; they do not update an installed Perry.
