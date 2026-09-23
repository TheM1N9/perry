# Install Perry

Perry is yours. You run your own deployment, with your own bot and your own
keys, and nobody else's data is anywhere near it. There is no shared server, no
account on someone else's system, and nothing in this repo phones home.

```bash
pnpm install
pnpm run setup
```

The setup wizard, the runner and the other scripts run on [Bun](https://bun.sh),
so install it first; pnpm still manages the packages.

That is the whole install. The wizard walks five steps, tells you what it is
doing, and is safe to re-run: it keeps whatever is already configured and only
asks for what is missing.

## What the wizard does

1. **Convex deployment.** Opens a browser once so you can log in and create
   your own project. This is your database and your backend. Free tier is
   ample for one person.
2. **Telegram bot.** Message [@BotFather](https://t.me/BotFather), send
   `/newbot`, answer two questions, paste the token back. The wizard checks it
   against Telegram before continuing.
3. **Codex.** Perry thinks with your ChatGPT subscription, through the
   [Codex CLI](https://github.com/openai/codex) on your machine. Install Codex,
   then after setup run `pnpm run connect` and sign in to Codex from the
   dashboard's Settings page.
4. **Secrets and deploy.** Generates a webhook secret and a dashboard key,
   writes them to a gitignored `.env.local`, sets them on your deployment,
   pushes the code, and registers the webhook.
5. **Pairing code.** Prints six digits.

Send those six digits to your bot. Whoever sends them first owns that install,
and from then on every other sender is ignored without a reply. Codes expire
after an hour.

Then:

```
/help
remember that I drink coffee black
what do you know about me
```

## Changing keys later

Everything except the dashboard key is editable on the **Keys** page: the bot
token, the webhook secret, Composio and Daytona. No
terminal, and changes apply on the next turn.

Keys entered there are write-only. The page shows whether one is set, where it
came from, and its last four characters, and never reads one back. A key saved
there overrides the matching environment variable, and clearing it falls back
to the environment variable if one exists.

`DASHBOARD_KEY` stays a terminal-only environment variable on purpose. It is
what guards that page, so it cannot be edited from behind it, and a lockout
stays recoverable:

```bash
pnpm exec convex env set DASHBOARD_KEY "<new key>"
```

## Connecting your machine

Perry thinks and works through Codex on a machine you connect. On it:

```bash
pnpm run connect   # mints a runner token and starts the runner
```

Then open Settings in the dashboard and sign in to Codex with your ChatGPT
account; the runner reports which Codex models your subscription offers. Keep
the runner running (`pnpm run runner` after the first time): chats wait for it,
and a message sent while it is offline fails with a clear error. Run one runner
per token; a second one refuses to start.

What Codex wants to do beyond its sandbox is asked in the runner's terminal and
in the dashboard, where you can approve or decline it.

On Windows the runner uses Codex's unelevated sandbox, because the elevated one
fails on long paths in Codex's own runtime. Set
`PERRY_CODEX_WINDOWS_SANDBOX=elevated` to use Codex's choice instead.

## Perry's folder on your machine

Setup and the runner create `~/.perry`, the way Claude Code has `~/.claude`
and Codex has `~/.codex`. Set `PERRY_HOME` to put it somewhere else.

```
~/.perry/
  runner.json      how this machine's runner connects
  uploads/         files you attach in chat
  files/           the agent's own folder for what it makes
  codex-results/   finished Codex turns not yet delivered
```

Chat media stays on your machine. Files you attach land in `uploads/`, the
agent saves what it makes wherever it decides (usually `files/`), and the
dashboard serves each file from where it is, only to someone holding the
dashboard key. Telegram is the exception: it can only fetch images by URL, so
images for Telegram chats go to Convex storage. If you host the dashboard
somewhere other than this machine, set `PERRY_MEDIA=convex` so uploads go to
Convex storage instead.

## Dashboard

```bash
pnpm run dev
```

Open http://localhost:3000 and paste the dashboard key the wizard printed. It
is also in `.env.local`.

The chat workspace keeps separate web conversations. Use **New chat** to start
one, search titles or message text with **Ctrl+K**, rename or delete a chat from
its sidebar menu, or choose **Branch from here** on a message to continue from
that point in a separate thread. Each chat shows a stable session ID in the
sidebar and header; the header copies the full ID. Older messages load on demand. Web chats share
Perry's saved memories with Telegram while keeping their histories separate.

The sidebar also opens Work, Computer, Connectors, Memory, Settings, Activity,
Keys, and Setup. Settings shows the Codex account on each connected machine;
Activity is a run log with session filters, tools, tokens, errors, and a link
back to each web chat. Chat holds the message history.

The key is a bearer token for one person, not a login system. Localhost does
not bypass it, because a dashboard that can read your memory should not be open
to anything else running on your machine.

## Other commands

| Command | What it does |
|---|---|
| `pnpm run doctor` | Checks every moving part and names the broken one. Changes nothing. |
| `pnpm run pair` | Fresh pairing code, for an expired one or a new chat. |
| `pnpm run webhook:info` | What Telegram thinks, including delivery errors. |
| `pnpm exec convex dev` | Watches `convex/`, pushes on save, streams logs. |

`pnpm run doctor` is the first thing to run when something seems wrong. It
checks the local env file, the deployment, its environment variables, the HTTP
endpoint, the bot token, the webhook registration and its delivery errors, and
whether anyone has claimed the install.

## Giving Perry to someone else

Send them the repo. They run `pnpm run setup`, which builds them a separate
deployment with separate everything. Your memories, keys, and conversations
stay on your deployment and are never visible to theirs.

What is not built is several people sharing one install. The dashboard key is a
single bearer token and memories are one pool with no per-person scoping.
Making that work means replacing the key with Convex Auth and adding an owner
id to three tables.

## Troubleshooting

**Perry will not answer.** `pnpm run doctor`. If ownership is unclaimed, send the
pairing code. If the webhook shows a delivery error, the secret on the
deployment and the one in `.env.local` disagree, so re-run `pnpm run setup`.

**"That broke: ..." in chat.** Perry reports failures instead of swallowing
them. The full error is in the Convex dashboard logs and in the Activity tab.

**"No runner" or "Connect a ChatGPT account" in chat.** Every reply comes from
Codex on a connected machine. Start the runner with `pnpm run runner` and check
the Codex account on the Settings page.

**Moving to production.** `pnpm exec convex deploy` pushes to a separate production
deployment with its own environment variables, so set them again there and
re-run the webhook registration against the production `.convex.site` URL.
