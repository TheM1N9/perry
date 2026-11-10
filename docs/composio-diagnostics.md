# Connected-action diagnostics (#265)

The account execution path was fixed in #305. This follow-up keeps enough evidence to distinguish unsupported request/project configuration from expired authentication, permission denial and rate limiting.

Failure inventory before integration checks:

- HTTP status lives on an SDK cause rather than the outer exception.
- Provider code 4300 and ToolRouterV2_BadRequest live in a nested error body or a JSON-formatted message.
- Code 4300 alone is incorrectly treated as proof of disabled multi-account selection.
- Raw error text includes access tokens, account IDs, request arguments or malicious recovery instructions.
- An expired credential is marked healthy, or an unrelated bad request marks the connection expired.
- Error results and thrown exceptions produce inconsistent diagnostics.
- Cyclic/deep/oversized error objects cause unbounded traversal or output.
- A 429 is retried immediately or mistaken for expired auth.

Use a bounded structural extractor and fixed, locally authored reasons/hints. Never return raw provider prose, headers, account identifiers or payloads. Preserve numeric provider codes and recognized SDK/router types; omit unknown string labels. Exercise the real action with the installed SDK and a local fixture provider; no paid or owner account calls.

## Verification

The action/SDK fixture passed eight checks on Windows. The existing internet-routing suite also passed its 14 functional checks after updating its provider fixture for #305's native execution endpoint, metadata read and connected_account_id. The previous fixture expected the removed router account option. Windows cleanup allows Chromium time to release profile handles.

Reproduce from this checkout:

```powershell
pnpm typecheck
pnpm exec bun build artifacts/composio-diagnostics/run.ts --target=node --packages=external --outfile=artifacts/composio-diagnostics/run.mjs
pnpm exec node artifacts/composio-diagnostics/run.mjs W:/perry-qa/composio-diagnostics
pnpm exec bun build artifacts/internet-routing/run.ts --target=node --packages=external --outfile=artifacts/internet-routing/run.mjs
$env:PERRY_CREDENTIAL_KEY = '11' * 32 # synthetic key for the isolated fixture home only
pnpm exec node --experimental-transform-types --import ./artifacts/composio-diagnostics/alias-loader.mjs artifacts/internet-routing/run.mjs
```

The source fixtures, JSON reports and loader are committed; generated bundles are disposable. No live account success or hosted service readiness is inferred from these checks.
