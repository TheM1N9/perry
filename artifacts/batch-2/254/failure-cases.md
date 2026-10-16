# Isolation failure inventory (written before E2E code)

- Project imports could read installed state or inherited secrets: set synthetic PERRY_HOME, dashboard/credential/provider keys first; import only Runtime, schema, Composio, identity/health modules. Never import bootstrap.
- SDK could call the network or telemetry: replace only @composio/core with a local fake via Node resolve hook; deny global fetch before imports. No engines, CLI, HTTP listener, app startup, services or scheduled tasks.
- Runtime scheduler could run unrelated jobs: instantiate only required modules, stop immediately before mutation; no cron configuration.
- SQLite/storage could escape scratch or fill disk: memory SQLite, storage solely under task scratch; compact JSON evidence; no downloads, copied dependencies or large files.
- Regression may mistake a first-time missing connection for expired, or 401/403/project API-key failure, rate limits, outages, or unrelated expiry prose for revoked auth.
- Session could select another account while health marks a toolkit or stale account: verify explicit account pinning; keep an active alternate; spoof wrong owner/toolkit refresh IDs.
- Provider payloads could leak credentials through action errors, health, or artifacts: synthetic sentinel in failures, assert absent from outputs/rows; persist only IDs/toolkit/timestamps.
- A successful reconnect could clear all accounts or be inferred from a healthy alternate: refresh only original account, require SDK ACTIVE without redirect; keep health during pending/failed flows.
- Older failed work could overwrite a later successful reconnect: observe start-time ordering and replay stale observation through Runtime.
- Identity lookup could hide failures, erase an existing label, or clear stale health without successful auth: exercise successful/failed probes.
- Disconnect could leave health, or mutate alternate accounts: remove exact health/account only.
- Fake SDK could drift from installed interface: base fake on inspected tools.getRawComposioToolBySlug, sessions.toolkits/execute(account), connectedAccounts.list/get/refresh/delete source; coordinator still owns real UI/build validation.
