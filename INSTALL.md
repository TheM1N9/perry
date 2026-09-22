# Install Perry

Perry is yours. You run your own deployment, with your own bot and your own
keys, and nobody else's data is anywhere near it. There is no shared server, no
account on someone else's system, and nothing in this repo phones home.

```bash
pnpm install
pnpm run setup
```

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
3. **Model access.** Paste a Vercel AI Gateway key, from the AI tab at
   vercel.com. It routes to Anthropic, OpenAI and others at list price with no
   markup. Leaving it blank falls back to Convex's own gateway, which needs no
   key but is only enabled on paid Convex plans.
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
token, the webhook secret, the model gateway key, Composio and Daytona. No
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

## Giving Agent P a computer

Optional, and only Agent P can reach it. Without it every other tool still
works and the sandbox tools report that no computer is configured.

```bash
pnpm exec convex env set DAYTONA_API_KEY "<key from daytona.io>"
```

Daytona gives $200 of signup credit and bills per second. A sandbox stops
itself after 15 idle minutes, so an install used a few times a week costs
close to nothing.

The sandbox has bash, Python, Node and git. Its /workspace survives between
commands, there are no credentials inside it, and nothing on your machine is
reachable from it.

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
Keys, and Setup. Settings controls the model, step budget, and tools per mode;
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

**A model is rejected.** Model names live in the Settings tab. The gateway's
rejection arrives in chat verbatim, so you can paste a different one and retry.

**Moving to production.** `pnpm exec convex deploy` pushes to a separate production
deployment with its own environment variables, so set them again there and
re-run the webhook registration against the production `.convex.site` URL.
