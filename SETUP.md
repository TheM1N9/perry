# Setup

Perry needs a Telegram bot and a Convex deployment. Budget fifteen minutes.

Everything below is done once. Steps 1 to 5 get you a working bot.

## 1. Telegram bot

Message [@BotFather](https://t.me/BotFather), send `/newbot`, answer the two
questions. It hands back a token like `8123456789:AAH...`. Keep it.

Optional but worth it, still in BotFather:

- `/setprivacy` then Disable, if you ever want Perry in a group chat.
- `/setcommands`, then paste:

```
help - what Perry can do
perry - read and remember only
agentp - full tools
mode - which mode am I in
status - plumbing and recent errors
reset - start a fresh conversation
```

## 2. Convex deployment

```bash
npm install
npx convex dev
```

The first run opens a browser to log in, then asks you to name the project. Say
yes to creating a new one. It prints two URLs and writes `.env.local` for you.

Leave `npx convex dev` running. It watches `convex/`, pushes on save, and
generates `convex/_generated`, which is why the project will not typecheck
until this has run once.

If the project already exists and you just need the code pushed without a
browser login, generate a deploy key in the Convex dashboard under Settings,
then:

```bash
export CONVEX_DEPLOY_KEY="<key>"
npx convex deploy
```

That works headlessly, which matters if an agent is doing the deploying.

## 3. Local env

```bash
cp .env.example .env.local
```

Fill in `TELEGRAM_BOT_TOKEN` and a long random `TELEGRAM_WEBHOOK_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`NEXT_PUBLIC_CONVEX_URL` was written by `npx convex dev`. `CONVEX_SITE_URL` is
the same deployment on the `.site` domain, so copy the `.convex.cloud` value and
change the suffix.

## 4. Deployment env

These live on Convex, not in any file. The `.env.local` copies are only for the
webhook script.

```bash
npx convex env set TELEGRAM_BOT_TOKEN      "<bot token>"
npx convex env set TELEGRAM_WEBHOOK_SECRET "<same secret as .env.local>"
npx convex env set AI_GATEWAY_API_KEY      "<vercel ai gateway key>"
```

`AI_GATEWAY_API_KEY` comes from the AI tab of your Vercel dashboard and is
required. Models are named as `provider/model` strings in `convex/modes.ts` and
resolved by the AI SDK through the Vercel AI Gateway, which does not mark up
token prices. Without the key every turn fails with an auth error from the
gateway, which Perry will report in chat.

Leave `TELEGRAM_OWNER_CHAT_ID` unset for now. Step 5 fills it in.

## 5. Point Telegram at Convex, then claim the bot

```bash
npm run webhook:set
```

Message your bot anything. It replies with your chat id and the exact command to
run, because an unclaimed Perry will not call a model or store anything. Run it:

```bash
npx convex env set TELEGRAM_OWNER_CHAT_ID <the id it gave you>
```

Message it again. That is a working Perry. Try:

```
/help
remember that I drink coffee black
what do you know about me
```

After that, messages from anyone else are dropped without a reply.

## 6. Dashboard

The web dashboard chats with the same agent, edits what Perry remembers, changes
the model per mode, and shows every turn it has taken. It is behind a single
key, so set one:

```bash
npx convex env set DASHBOARD_KEY "$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"
```

Print it back with `npx convex env get DASHBOARD_KEY`, then:

```bash
npm run dev
```

Open http://localhost:3000 and paste the key. It is kept in the browser and
sent with every call, so locking the tab is one button and rotating the key is
one command.

Note what this is: a bearer key for one person, not accounts. Every public
function checks it before doing anything, so there is one line to audit per
entry point, and that line is where Convex Auth would go if Perry ever served
more than one person.

## You do not need a tunnel

The reflex from webhook development is to reach for ngrok or a Cloudflare
tunnel. Perry has no local server to expose. Convex HTTP actions are hosted, so
`https://<deployment>.convex.site` is already a public HTTPS endpoint on a
stable domain, which is exactly and only what Telegram requires.

A Cloudflare quick tunnel would be worse than nothing here. The
`trycloudflare.com` hostname it hands out is ephemeral and dies with the
process, so Perry would stop receiving messages the moment the tunnel exits,
and the failure looks like silence rather than an error.

Two cases where a tunnel is the right tool:

- You are running the **self-hosted Convex backend** locally instead of using
  the cloud deployment. Then there is a real local port to expose.
- You want Perry on **your own domain** rather than the Convex one. A named
  tunnel or a Cloudflare Worker proxying to the `.convex.site` origin both
  work, and the webhook then points at your hostname.

Neither applies to a standard cloud deployment.

## Troubleshooting

**"This Convex deployment does not have HTTP actions enabled."** Curling
`/health` returns this when the project exists but `convex/http.ts` has never
been pushed. The deployment is empty. Run `npx convex dev` or the deploy-key
command in step 2, then curl again; a healthy deployment answers with JSON.

**No reply at all.** `npm run webhook:info` shows Telegram's view, including
`last_error_message`. A 403 there means the secret in `.env.local` and the one on
Convex disagree.

**"That broke: ..." in chat.** Perry reports failures instead of swallowing
them. The full error is in the Convex dashboard logs, and `/status` shows the
most recent one.

**Nothing deploys.** `npx convex dev` has to be running. Check the terminal for
a push error.

**Wrong model name.** Model slugs live in `convex/modes.ts`. If the gateway
rejects one, the error arrives in chat verbatim and you can swap the string.

## Deploying for real

```bash
npx convex deploy
```

That pushes to production, which is a different deployment with its own env
vars, so set all four again against it and re-run `npm run webhook:set` with the
production `.site` URL.

The Next.js app is only a placeholder page today. Deploy it to Vercel whenever
the dashboard becomes worth having.
