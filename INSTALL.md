# Install Perry

Perry is yours. You run your own deployment, with your own bot and your own
keys, and nobody else's data is anywhere near it. There is no shared server, no
account on someone else's system, and nothing in this repo phones home.

```bash
npm install
npm run setup
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
3. **Model access.** Press enter to use Convex's own AI gateway, which needs no
   extra signup. If you already have a Vercel AI Gateway key, paste it instead.
   Neither marks up token prices.
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

## Giving Agent P a computer

Optional, and only Agent P can reach it. Without it every other tool still
works and the sandbox tools report that no computer is configured.

```bash
npx convex env set DAYTONA_API_KEY "<key from daytona.io>"
```

Daytona gives $200 of signup credit and bills per second. A sandbox stops
itself after 15 idle minutes, so an install used a few times a week costs
close to nothing.

The sandbox has bash, Python, Node and git. Its /workspace survives between
commands, there are no credentials inside it, and nothing on your machine is
reachable from it.

## Dashboard

```bash
npm run dev
```

Open http://localhost:3000 and paste the dashboard key the wizard printed. It
is also in `.env.local`.

From there you can chat with the same agent Telegram talks to, edit what Perry
remembers, change the model and step budget and tool allowlist per mode, and
read a log of every turn with its tools, tokens and errors.

The key is a bearer token for one person, not a login system. Localhost does
not bypass it, because a dashboard that can read your memory should not be open
to anything else running on your machine.

## Other commands

| Command | What it does |
|---|---|
| `npm run doctor` | Checks every moving part and names the broken one. Changes nothing. |
| `npm run pair` | Fresh pairing code, for an expired one or a new chat. |
| `npm run webhook:info` | What Telegram thinks, including delivery errors. |
| `npx convex dev` | Watches `convex/`, pushes on save, streams logs. |

`npm run doctor` is the first thing to run when something seems wrong. It
checks the local env file, the deployment, its environment variables, the HTTP
endpoint, the bot token, the webhook registration and its delivery errors, and
whether anyone has claimed the install.

## Giving Perry to someone else

Send them the repo. They run `npm run setup`, which builds them a separate
deployment with separate everything. Your memories, keys, and conversations
stay on your deployment and are never visible to theirs.

What is not built is several people sharing one install. The dashboard key is a
single bearer token and memories are one pool with no per-person scoping.
Making that work means replacing the key with Convex Auth and adding an owner
id to three tables.

## Troubleshooting

**Perry will not answer.** `npm run doctor`. If ownership is unclaimed, send the
pairing code. If the webhook shows a delivery error, the secret on the
deployment and the one in `.env.local` disagree, so re-run `npm run setup`.

**"That broke: ..." in chat.** Perry reports failures instead of swallowing
them. The full error is in the Convex dashboard logs and in the Activity tab.

**A model is rejected.** Model names live in the Settings tab. The gateway's
rejection arrives in chat verbatim, so you can paste a different one and retry.

**Moving to production.** `npx convex deploy` pushes to a separate production
deployment with its own environment variables, so set them again there and
re-run the webhook registration against the production `.convex.site` URL.
