# Connected account details verification

Failure inventory before E2E changes:

- Profile replies omit optional fields or nest them under user/profile objects.
- An email, username, display name, workspace, or connection date is hidden.
- A long identity is truncated in storage, merged with another account, or overflows on phones.
- Two workspace accounts share a username and are incorrectly grouped together.
- Search misses a secondary profile field.
- Existing cached identities never gain details, or every load repeats the profile request.
- Expired connections or failed lookups lose previously known details.
- A service with no profile action stops showing the connection-date fallback.
- Auth tokens or unrecognized provider fields leak into the dashboard response.
- Duplicate connection cleanup and reconnect controls regress.

Use the existing connector E2E fixture with synthetic provider replies, the installed Composio SDK, actual backend and dashboard. Save JSON results and desktop/mobile screenshots.

Repeat with `pnpm build`, then `pnpm exec bun artifacts/connector-details/run.ts`.
The replay uses an isolated temporary Perry home and local provider, upgrades an old cached identity, checks cache reuse and expiration, and verifies account grouping, search, and long identities on the actual dashboard. It writes `results/result.json` and desktop/mobile screenshots. No owner account or live provider calls are used.
