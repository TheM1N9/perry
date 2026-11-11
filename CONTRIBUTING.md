# Contributing to Perry

Thanks for helping. Open an [issue](https://github.com/TheM1N9/perry/issues)
before starting on anything large, so the approach can be agreed first. Every
change goes in through a pull request against `main`.

## Running from source

You need Node.js 22.13 or newer, [pnpm](https://pnpm.io), [Bun](https://bun.sh)
and one engine's CLI signed in: [Codex](https://github.com/openai/codex),
[Claude Code](https://code.claude.com) or Grok Build. `perry setup` asks which
one Perry uses by default (`--engine <name>` answers without asking). Use
pnpm, not npm.

```bash
git clone https://github.com/TheM1N9/perry.git
cd perry
pnpm install
pnpm perry setup    # writes .env.local, asks for the default engine, connects this computer, starts Perry
```

For working on the dashboard with hot reload, stop the background service
(`pnpm perry stop`) and run the two halves yourself:

```bash
pnpm dev            # dashboard and backend on http://localhost:7377
pnpm runner         # the runner, in another terminal
```

`pnpm chat` talks to Perry from the terminal, which is handy for trying a
change without the dashboard.

## How it fits together

```
Telegram / WhatsApp ─┐
                     ├─> Perry's server: dashboard + backend ─> runner ─> the engine (Codex, Claude Code, ...)
Web chat ────────────┘    SQLite in ~/.perry
```

| Folder | What is there |
|---|---|
| `app/`, `components/` | The dashboard (Next.js) |
| `convex/` | Backend functions: chats, memory, jobs, approvals, Perry's MCP tools |
| `server/` | The local runtime those functions run on, over SQLite |
| `runner/` | The process that drives the engines on your machine (Bun) |
| `scripts/` | The `perry` CLI: setup, service, update, doctor |
| `pet/` | The desktop companion (Electron) |
| `site/` | The public landing page, a separate Next.js app |
| `evals/` | Behaviour checks against a live Perry |

The functions in `convex/` are written in Convex's style but run locally; no
Convex deployment is involved.

## Checks

CI runs these on macOS, Linux and Windows; run them before opening a PR:

```bash
pnpm exec tsc --noEmit -p convex
pnpm typecheck
bun scripts/smoke.ts
```

### Evals

Evals drive fresh web chats on a live Perry and assert on the replies and on
which tools ran. Each one cleans up its chats and memories when it ends, and
none of them message Telegram.

```bash
pnpm evals                  # all of them
pnpm evals --tag memory     # those tagged memory
pnpm evals search-chats     # one, by file name
```

They need a runner started with `--auto`, since nobody is there to approve.
To keep them off your own runner, start a short-lived one:

```bash
TOKEN=$(pnpm run -s connect -- --token-only --name evals | awk '/token/ {print $2}')
mkdir -p /tmp/perry-evals-work
PERRY_HOME=/tmp/perry-evals bun runner/index.ts --url http://127.0.0.1:7377 --token "$TOKEN" --dir /tmp/perry-evals-work --name evals --auto &
pnpm evals --runner-token "$TOKEN"
kill %1   # then revoke "evals" in the dashboard's Settings → Computers
```

Results land in `artifacts/evals/<time>/`.

## Landing page

```bash
cd site
pnpm install
pnpm dev
```

## Verification evidence

Keep executable checks and their required fixtures in `artifacts/`. Write new screenshots, recordings and large result bundles to a disposable output directory or CI storage; CI uploads expire after 14 days. The older `fewer-boxes` screenshots were removed because no check reads them; its seed, replay and compact result record remain. Recover the original pictures from Git history when comparing the October design. Other historical bundles stay until their fixtures and references have been separated.

The product typecheck excludes historical harnesses. CI checks those separately with `pnpm exec tsc --noEmit -p artifacts`.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
