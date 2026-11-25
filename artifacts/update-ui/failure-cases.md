# Update recovery E2E inventory

- A hand-started server reports a generic failure instead of explaining `perry start` / `perry update`.
- Denied sessionStorage reads, writes or removal crash any mounted update control.
- Installing never reaches the server because its optional reload marker cannot persist.
- A failed request leaves controls disabled or a stale marker; retry sends a duplicate request.
- Available/ready/failed updates are hidden because a historical fixture expects obsolete labels.
- Long technical diagnostics overflow the settings panel.

Use the production Next build, real HTTP/SQLite handlers, isolated homes and browser profiles. No real supervisor, runner, updater or engine is launched. Seed only update metadata in the disposable database. Each run emits a JSON result; teardown closes browsers/servers and removes disposable homes.
