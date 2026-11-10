# PR 302 verification

Run `pnpm exec bun artifacts/pr-302/e2e.ts`. It writes `results/result.json`.
The fixture runs the real OpenCode adapter, child-process CLI probes, bundled
permission plugin, and ACP SDK over stdio. Commands, provider credentials and
models are synthetic; no paid model or real provider account is used. It checks
Ask/Auto denial, Full access, cold session resume, configured default selection,
model fallback, and noninteractive/failed/environment-provider logout.

`pnpm typecheck`, `pnpm exec tsc --noEmit -p convex`, and `pnpm run smoke`
(9/9 Windows checks) also pass. The original startup/doctor fixes were retained.

Approval integration follows OpenCode v2.0.30's Promise plugin API and requires
OpenCode 2.x. The plugin directory is deliberate: V2 ignores configured plugin
paths that point to individual files.
