# Install Perry

Perry is yours. You run your own deployment, with your own bot and your own
keys, and nobody else's data is anywhere near it. There is no shared server, no
account on someone else's system, and nothing in this repo phones home.

```bash
curl -fsSL https://raw.githubusercontent.com/TheM1N9/perry/main/install.sh | sh    # macOS, Linux, WSL
```

```powershell
iwr -useb https://raw.githubusercontent.com/TheM1N9/perry/main/install.ps1 | iex   # Windows
```

The installer adds what is missing: Git (Windows, through winget), Node.js 20.9
or newer (winget on Windows; on macOS and Linux, Node's own build in
`~/.perry/node`, checked against its published checksum), pnpm, Bun and the
Codex CLI. On macOS and Linux nothing it installs needs sudo. It clones Perry
into `~/perry` (`PERRY_DIR` changes that), installs the packages, and runs
`perry setup`, which walks the steps below, connects this computer, builds the
dashboard, starts Perry in the background, and opens the dashboard already
unlocked. Run the installer again to update; `perry update` does the same from
then on.

In a clone of your own, the same without the installer:

```bash
pnpm install
pnpm perry setup
```

Perry runs on macOS, Linux and Windows:

| | macOS | Linux | Windows |
|---|---|---|---|
| Bun | `curl -fsSL https://bun.sh/install \| bash` | `curl -fsSL https://bun.sh/install \| bash` | `powershell -c "irm bun.sh/install.ps1 \| iex"` |
| Codex CLI | `brew install --cask codex` or `npm i -g @openai/codex` | `npm i -g @openai/codex` or `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `npm i -g @openai/codex` |
| Codex's sandbox | Seatbelt, built in | bubblewrap, shipped with Codex; needs user namespaces | a restricted token, set up by Codex |
| Background service | launchd agent | systemd user unit | Task Scheduler task at logon |

`perry doctor --machine` checks all of that on the machine it runs on.

That is the whole install. The wizard walks five steps, tells you what it is
doing, and is safe to re-run: it keeps whatever is already configured and only
asks for what is missing.

## Running it

`perry setup` leaves Perry running: the runner and the dashboard (a production
build on port 3000; `PERRY_PORT` changes it) under one background service that
starts at every login and restarts either one if it crashes. From then on:

| | |
|---|---|
| `perry status` | whether it is running, and where the dashboard is |
| `perry logs [-f]` | what the runner and the dashboard have been saying |
| `perry open` | the dashboard, already unlocked in this browser |
| `perry stop` / `perry start` | stop it, or start it again |
| `perry update` | pull the latest Perry, install, push the backend, rebuild, restart |
| `perry doctor` | check this machine and your deployment |
| `perry pair` | a new code to claim Perry on Telegram |
| `perry run` | run it in this terminal instead, to watch it or to answer approvals there |
| `perry uninstall` | stop starting it at login; your settings and data stay |

The `perry` command is a small launcher in `~/.perry/bin`, added to your PATH,
that runs the CLI from your checkout whatever folder you are in. Codex works in
`~/.perry/workspace` unless you connected with another folder.

## What the wizard does

1. **Convex deployment.** Opens a browser once so you can log in to Convex,
   then creates a project named `perry` in your account, in Convex's cloud
   (where Telegram can reach it). If you belong to several Convex teams, it
   asks which one; nothing else. This is your database and your backend. Free
   tier is ample for one person. A deployment left over from choosing "Start
   without an account" is replaced with a cloud one.
2. **Telegram bot, optional.** To talk to Perry on Telegram as well as in the
   dashboard, message [@BotFather](https://t.me/BotFather), send `/newbot`,
   answer two questions, and paste the token back; the wizard checks it against
   Telegram before continuing. Press Enter to skip, and Perry is yours from the
   dashboard alone. A bot can be added later: save its token on the **Keys**
   page, press **Register webhook**, then pair it from **Setup**. Without a bot,
   job results and page-watch alerts stay in the dashboard (a job's results in
   its own chat) rather than reaching you as messages.
3. **Codex.** Perry thinks with your ChatGPT subscription, through the
   [Codex CLI](https://github.com/openai/codex) on your machine, so it signs
   you in now, before the first chat needs it: `codex login` in the browser,
   or a device code where there is no browser (a server, or over SSH). If
   you are already signed in, it says so and moves on. Setup stops if Codex
   is not installed. The dashboard's Settings page can sign in too.
4. **Secrets and deploy.** Generates a webhook secret and a dashboard key,
   writes them to a gitignored `.env.local`, sets them on your deployment,
   pushes the code, and registers the webhook if there is a bot.
5. **Pairing code.** With a bot, prints six digits. Without one there is
   nothing to claim: the dashboard key is the owner's key.

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

To be answered while the machine is off, turn on **Answer without the computer
when it's offline** in Settings. A turn no runner can take is then answered in
Convex on your ChatGPT subscription, with memory, chats, connected accounts,
jobs and page reading but nothing from your machine. Settings shows whether a
token is valid and until when. The risk: each runner shares the ChatGPT access
token its Codex holds, and it stays in your Convex deployment until it expires,
usable by anyone who can read that deployment's data. The refresh token never
leaves the machine, and turning the setting off deletes every stored token.

What Codex wants to do beyond its sandbox is asked in the runner's terminal, in
the dashboard and, if you own Perry from Telegram, as a Telegram message with
Approve, Decline and Always allow buttons. The buttons need the webhook to
receive `callback_query` updates: an install whose webhook was set before this
must set it again, with `pnpm run webhook:set` or the Keys page's re-register
button. Turn Telegram prompts off on the Computer page.

Each machine has a policy, set on the Computer page or when starting it:

```bash
pnpm run runner -- --policy review   # ask | review | trust; --auto means trust
```

With `review`, a quick Codex turn on your subscription looks at each request
first and runs the routine ones; the rest are asked. `PERRY_REVIEW_MODEL`
picks its model (by default the first model Codex lists as fast).

Codex is told which OS and shell it is on (PowerShell on Windows, your login
shell such as zsh or bash elsewhere), so its commands, paths and "open this"
requests fit the machine.

### Running it in the background

To keep the runner going without a terminal, and start it whenever you log in:

```bash
pnpm run connect -- --service   # connect, and install the runner as a service
pnpm run service install        # or: install it for a runner already connected
pnpm run service status         # also: start, stop, logs [-f], uninstall
```

Each OS's own service manager runs it, for your user only and without admin
rights:

- **macOS**: a launchd agent, `~/Library/LaunchAgents/com.perry.runner.plist`.
  Logs go to `~/.perry/logs/runner.log`.
- **Linux**: a systemd user unit, `~/.config/systemd/user/perry-runner.service`.
  Logs are in the journal (`pnpm run service logs`). A user unit stops when you
  log out; `loginctl enable-linger $USER` keeps it running and starts it at boot.
  Under WSL, systemd must be on (`[boot] systemd=true` in `/etc/wsl.conf`).
- **Windows**: a Task Scheduler task, "Perry runner", that starts at logon in a
  hidden window. Logs go to `~/.perry/logs/runner.log`. Unlike the task
  defaults, it has no time limit and keeps running on battery.

The service remembers the `PATH` it was installed from (launchd and systemd
start services with a bare one), and any `PERRY_HOME`, `PERRY_CODEX_SANDBOX`,
`PERRY_CODEX_WINDOWS_SANDBOX` or `CODEX_HOME`, so reinstall it after changing
those or moving the repo. With no terminal to ask in, approvals are answered in
the dashboard. Stop the service before running the runner in a terminal with
the same token; a second runner refuses to start.

### Codex's sandbox

The runner asks Codex for its `workspace-write` sandbox: Codex may write in the
working directory, in `~/.perry/files` and in the temp folder, the network is
off, and anything else is asked for. How Codex enforces that depends on the OS:

- **macOS**: Seatbelt (`sandbox-exec`), part of macOS. Nothing to install.
- **Linux**: bubblewrap, which Codex ships with (Landlock is its older
  fallback). It needs unprivileged user namespaces, which desktop distributions
  and WSL 2 have. Inside Docker and similar containers they are usually off,
  and every sandboxed command fails; either allow them, or, since a container is
  already a sandbox, set `PERRY_CODEX_SANDBOX=danger-full-access`. Some
  distributions restrict user namespaces with AppArmor (Ubuntu 24.04 and later
  can); if sandboxed commands fail there, install the distribution's
  `bubblewrap` package, which Codex can use instead of its own.
- **Windows**: a restricted token. The runner uses Codex's unelevated sandbox,
  because the elevated one fails on long paths in Codex's own runtime. Set
  `PERRY_CODEX_WINDOWS_SANDBOX=elevated` to use Codex's choice instead.

`PERRY_CODEX_SANDBOX` overrides the mode on any OS: `read-only`,
`workspace-write` (the default) or `danger-full-access`. With
`danger-full-access` Codex asks for almost nothing, so keep it to machines that
are isolated already. `pnpm run doctor -- --machine` runs one sandboxed command
on macOS and Linux to show the sandbox works.

All of this is for **Supervised** chats, the default. A chat set to **Full
access** (in its composer, with `/access full`, or by the default for new chats
in Settings) runs every turn with `danger-full-access` and approval policy
`never` whatever `PERRY_CODEX_SANDBOX` says: no sandbox, and Codex never asks.
`PERRY_CODEX_SANDBOX` still sets the sandbox of every Supervised chat on that
machine, so with it set to `danger-full-access` even a Supervised chat runs
unsandboxed, though Codex still asks there before anything it judges risky.

## Perry's folder on your machine

Setup and the runner create `~/.perry`, the way Claude Code has `~/.claude`
and Codex has `~/.codex`. Set `PERRY_HOME` to put it somewhere else.

```
~/.perry/
  runner.json      how this machine's runner connects
  uploads/         files you attach in chat
  files/           the agent's own folder for what it makes
  skills/          the agent's skills, one folder each with a SKILL.md
  codex-results/   finished Codex turns not yet delivered
  logs/            the runner's output as a service (macOS, Windows)
  service/         the Windows task's launcher
```

Paths work as each OS writes them: `/Users/...` on macOS, `/home/...` on Linux,
`C:\Users\...` on Windows, spaces and non-ASCII names included.

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

The sidebar holds your chats, Search, and Tasks: scheduled jobs, Perry's plans,
goals, and watched pages. Everything else opens from your name at the bottom of
the sidebar: Memory, Connectors, Activity, Computer, Settings, Keys, and Setup.
Settings shows the Codex account on each connected machine; Activity is a run
log with session filters, tools, tokens, errors, and a link back to each web
chat.

The key is a bearer token for one person, not a login system. Localhost does
not bypass it, because a dashboard that can read your memory should not be open
to anything else running on your machine.

## Other commands

| Command | What it does |
|---|---|
| `pnpm run doctor` | Checks every moving part and names the broken one. Changes nothing. |
| `pnpm run doctor -- --machine` | Only this machine: Bun, Codex and its sign-in and sandbox, the runner, the service. |
| `pnpm run service <command>` | The runner as a background service: `install`, `uninstall`, `start`, `stop`, `status`, `logs`. `--dry-run` shows what it would do. |
| `pnpm run smoke` | The runner's parts on this OS, with no deployment or Codex. CI runs it on all three. |
| `pnpm run pair` | Fresh pairing code, for an expired one or a new chat. |
| `pnpm run webhook:info` | What Telegram thinks, including delivery errors. |
| `pnpm exec convex dev` | Watches `convex/`, pushes on save, streams logs. |

`pnpm run doctor` is the first thing to run when something seems wrong. It
checks this machine (Bun, the Codex CLI, its sign-in and sandbox, the runner and
its service), the local env file, the deployment, its environment variables,
the HTTP endpoint, the bot token, the webhook registration and its delivery
errors, and whether anyone has claimed the install.

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
Codex on a connected machine, unless answering without the computer is on and a
runner has shared a token that is still valid. Start the runner with
`pnpm run runner` (or `pnpm run service start`) and check the Codex account on
the Settings page.

**Codex's commands all fail on Linux.** Its sandbox needs user namespaces; see
"Codex's sandbox" above, and run `pnpm run doctor -- --machine`.

**Moving to production.** `pnpm exec convex deploy` pushes to a separate production
deployment with its own environment variables, so set them again there and
re-run the webhook registration against the production `.convex.site` URL.
