# Perry

A personal AI assistant that lives in your chat app and your browser, remembers
you, acts on your connected accounts, and works on your own machine. It thinks
with your ChatGPT subscription, through the Codex CLI. Inspired by OpenClaw.

One install, one owner. Anyone can run their own copy, and every copy is
separate: its own computer, its own bot, its own keys, its own memory. There
is no server anywhere but yours, no account to make but Codex's, and nothing
here phones home.

One line installs it, on macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/TheM1N9/perry/main/install.sh | sh
```

or on Windows, in PowerShell:

```powershell
iwr -useb https://raw.githubusercontent.com/TheM1N9/perry/main/install.ps1 | iex
```

It installs what is missing (Node.js, pnpm, [Bun](https://bun.sh) and the
[Codex CLI](https://github.com/openai/codex)), puts Perry in `~/perry`, and runs
`perry setup`: a Telegram bot if you want one, Codex signed in, Perry running in
the background from every login on, and the dashboard opened, already unlocked. Then:

```bash
perry status    # is it running, and where
perry logs -f   # what it is saying
perry open      # the dashboard, unlocked
perry update    # the latest Perry, rebuilt and restarted
perry stop | start | doctor | pair | migrate | uninstall
```

In a clone, `pnpm install` then `pnpm perry setup` does the same. See
[INSTALL.md](INSTALL.md) for each OS.

## How it works

```
Telegram (polled) ─┐
                   ├─> Perry's server: dashboard + backend ─> runner ─> Codex
Web chat ──────────┘    SQLite in ~/.perry, on this computer
```

- **Perry's server** is the dashboard's Next.js server, and Perry's backend runs
  inside it (`server/`, started by `instrumentation.ts`): chats, messages,
  memory, USER.md, tasks, jobs, approvals and every run, in one SQLite file,
  `~/.perry/perry.sqlite`. The functions in `convex/` are written in Convex's
  style and run on a small local runtime with its rules: transactional
  mutations, a persisted scheduler, crons, and live queries that update the
  dashboard as the data changes. It asks Telegram for new messages (long
  polling), so nothing needs to be reachable from the internet.
- **The runner** (started with the server by `perry start`) is the process
  that drives Codex. The server connects it on its own; it talks to the server
  over HTTP and a server-sent event stream. It runs under the OS's own service
  manager (launchd, systemd or Task Scheduler), or in a terminal with `perry run`.
- **Codex** does the thinking and the work. Each chat turn becomes a Codex turn
  on the runner, in a workspace folder you chose, with your model of choice.
  Codex has a shell and file access there under its sandbox (Seatbelt on
  macOS, bubblewrap on Linux, a restricted token on Windows), is told which OS
  and shell it is on, and reaches Perry's own tools over MCP on the server.

A turn: the message is stored, memory and recent history are gathered, the turn
is queued for the runner, Codex writes the reply (streamed live to the web chat
and into a single Telegram message), and the finished reply is saved.

**Perry answers while your computer is on.** Asleep or off, nothing runs:
Telegram keeps a bot's messages for a day and they are answered on waking,
and scheduled jobs and page watches run then. For an assistant that is always
there, run Perry on a machine that stays on (a Mac mini, a small home server).
Another machine can still do the work too: `pnpm run connect -- --token-only`
on Perry's computer, then `pnpm run connect -- --url … --token …` on the other
(over Tailscale, say).

### Moving from Convex

Perry used to keep everything in a Convex deployment. After `perry update`,
`perry setup` offers to bring it over, or run `perry migrate`: it exports the
deployment (chats, messages, memory, USER.md, tasks, jobs and files) and
imports it here, keeping every id. The Convex deployment is only read; delete
it at dashboard.convex.dev when you no longer need it.

## What the assistant can do

Codex brings its own shell, files, image generation and plugins. Perry adds its
tools over MCP (`convex/mcp.ts`), served only while the runner has a turn
running:

| Tool | What it does |
|---|---|
| `recall` `remember` `read_memory` `forget` | Layered memory: profile, long-term, daily notes |
| `update_user_md` `update_identity` | Keep USER.md current; rename itself or change its personality when you ask |
| `search_chats` `read_chat` | Search and read earlier conversations, on every channel |
| `list_connectors` `find_action` `run_action` | Your connected accounts, through Composio |
| `start_task` `set_plan` `finish_task` `status_report` `set_goal` `update_goal` | Work that outlives the message |
| `watch_page` `update_watch` `delete_watch` `check_watches` `read_page` | Recurring page checks, and reading public pages |
| `create_job` `list_jobs` `update_job` `delete_job` `run_job` | Scheduled prompts and one-time reminders in your timezone |
| `share_file` | Show a file from your machine in the chat |

Connected accounts are looked up at the moment of use, never baked in: link
Google Calendar in the dashboard and the next turn can use it. Perry never holds
a token; Composio keeps the OAuth.

## You stay in control

- **Supervised or Full access, per chat.** A *Supervised* chat (the default)
  runs Codex in its `workspace-write` sandbox, and anything beyond it goes
  through the approvals below. *Full access* runs Codex with no sandbox
  (`danger-full-access`) and approval policy `never`, so it acts without
  asking; every command still shows in the trace, and the runner still refuses
  its deny list for anything that reaches it, though Codex's own commands no
  longer do. Pick it in the composer, where Full access is marked in amber, or
  with `/access supervised|full`; it applies from the chat's next reply.
  Settings has the default for new chats. A job's chat runs supervised unless
  it is set otherwise.
- **Approvals.** Whatever Codex or the runner wants to do beyond its sandbox is
  asked in the runner's terminal, in the dashboard and on Telegram (with
  Approve, Decline and Always allow buttons) at once; the first answer wins,
  and an unanswered request is declined after ten minutes. A hard deny list is
  refused outright. A runner running as a background service has no terminal,
  so it asks only in the dashboard and on Telegram.
- **Always allow.** Saves a rule on that machine: the exact command (or a
  command prefix Codex proposes) in that folder, or file changes under a
  folder. Rules, and how often each was used, are listed on the Computer page,
  where you can delete them. Declines are never remembered.
- **Policy per machine.** Chosen on the Computer page, or with
  `--policy ask|review|trust` on the runner. *Ask* (the default) asks you.
  *Review* first has a separate, tool-less Codex turn on your subscription
  (in the manner of [eve](https://github.com/vercel/eve)'s `auto()`) judge the
  single action, never the conversation: routine ones run, and anything risky,
  unclear or unanswered in 30 seconds is asked. *Trust* (`--auto`) runs
  everything. Every request is recorded, with who or what allowed it and the
  reviewer's verdict.
- **Stop.** A running reply can be stopped from the chat or with `/stop`; what
  it had written is kept.
- **Steer.** A message sent while a reply is running joins that reply (Codex's
  `turn/steer`) instead of waiting behind it, on the web and on Telegram. If
  the reply ends first, the message is answered next as usual. Job prompts
  still wait their turn.
- **Compact.** `/compact` has Codex summarise a long chat's thread so it
  carries less context; the chat's messages are unchanged.
- **Regenerate and edit.** Rewrite a reply, or change a message you sent and
  resend it; Codex starts from the history as it now stands.
- **Models and thinking.** Pick a Codex model per chat in the composer, or with
  `/model`, and its thinking level (the reasoning effort Codex runs the turn
  with) from the levels that model takes, or with `/think <level>`; `/think`
  alone lists them. "Default" leaves it to the model. A level the chat's model
  does not take is kept but unused, and says so.
- **Receipts.** Every turn is a run in the Activity page, with its model and
  thinking level (and "full access" when it had it), tools,
  tokens and errors, and a trace of what Codex did: each command, file change,
  tool call and search on a timeline, with its input, output and status.

Tool output, web pages and account data are treated as untrusted data in the
instructions, and consequential actions (sending, deleting, publishing,
spending) are to be confirmed in chat first.

## Memory

Modelled on OpenClaw's workspace memory, in SQLite on your computer:

- **USER.md**: who you are, in your own Markdown: what to call you, your work,
  a typical day, the people who matter, how you like replies, what you want
  help with and your boundaries. Loaded whole at the end of every turn's
  instructions.
- **Identity** (like `IDENTITY.md`): the assistant's name and personality,
  which you choose. At the start of every turn's instructions.
- **Profile**: standing preferences and rules for how to work, as directives.
  In every turn's instructions.
- **Long-term** (like `MEMORY.md`): durable facts and decisions. Recalled into
  every turn.
- **Daily notes** (like `memory/YYYY-MM-DD.md`): today's and yesterday's are
  recalled; older days are found by search, with a 30-day half-life on their
  ranking.

Recalled memory is data, not instructions (as in Vercel's
[eve](https://github.com/vercel/eve)): long-term memory, recent notes and older
memories that match the message go to Codex ahead of the message, marked as
possibly incomplete or outdated, and are never saved into the chat. A chat is
sent them again only when they change. Profile and long-term memory each have a
budget, and a save that would exceed it is refused with a request to supersede
or forget something first, so nothing silently drops out of context. Each
memory records whether it came from you, from tool output such as a web page,
or from a scheduled job.

A fact that changes is superseded, not deleted. Chat history is separate and
searchable by the agent with `search_chats`. `/reset` first has the assistant
write what is worth keeping from the chat into today's notes, then starts the
chat afresh; if the runner is offline it resets anyway and says so.

Memory keeps itself current, like OpenClaw's memory flush and dreaming: the
built-in **daily summary** job (22:30) reads the day's chats and writes what is
worth keeping as daily notes, and **memory consolidation** (03:00) promotes
what the last week's notes show to be durable into the profile and long-term
memory, and brings USER.md up to date with what you said about yourself. Both
work quietly.

### Getting to know you

A new install opens the dashboard on a welcome page before the first chat: name
the assistant and pick its personality, answer a few questions about yourself
(all optional), and review the USER.md written from your answers. Saving opens
a chat where the assistant speaks first, having read it. "I'd rather just chat"
skips the form and has the assistant ask the same questions in the chat,
writing USER.md as it learns. An install from before the welcome page is
offered it on the chat page instead.

Afterwards, **Profile → About you** edits USER.md and the identity, shows every
version with who wrote it (you, the assistant, or a scheduled job), restores an
older one, and opens the welcome page again. The assistant updates USER.md
when you tell it something lasting about yourself, and changes its name or
personality only when you ask.

## Proactivity

Jobs are prompts on a cron schedule in your timezone (reported by the
dashboard), or run once at a set time, run as Codex turns. Each has a chat
where its results collect, and a result is also sent to you on Telegram. A job
whose prompt makes delivery conditional ("only tell me if…") stays silent when
there is nothing new, by replying `NOTHING`. The built-in **heartbeat** looks
over tasks, goals, watches and recent memory a few times a day and speaks only
when something needs you. Ask the assistant for a job ("every weekday at 8,
brief me on my calendar") or a reminder ("remind me in 20 minutes to call
Sam") and it creates one; a one-time job pauses after it runs. It can rename,
reschedule, pause or resume them too.

## Skills

Skills are instructions for a kind of work, one folder each in
`~/.perry/skills/<name>/SKILL.md`, with `name` and `description` frontmatter.
The runner registers the folder with Codex, which lists every skill to the
agent by its description, and a turn may write there without asking. Ask for a
lasting change ("from now on, always…", "stop doing X") and the agent makes it
last instead of complying once: a preference goes to profile memory, a way of
doing something into a skill it writes or updates. The skill rules follow
Vercel's [eve](https://github.com/vercel/eve).

## Media

Files stay on your machine. Attachments land in `~/.perry/uploads`, the agent
keeps what it makes wherever it decides (usually `~/.perry/files`), and the
dashboard's own server serves each file from where it is, only to the holder of
the dashboard key. Telegram photos, voice notes and documents are downloaded
and attached like any upload, up to the 20 MB a bot may download; a bigger one
gets a plain reply saying so. Codex cannot hear audio, so voice notes need a
speech-to-text tool on the machine.

On Telegram, what the agent shares or generates is uploaded by the runner to
Perry's server and sent as a real file: photos, GIFs, videos, audio and voice
notes as themselves, anything else (or anything Telegram refuses in its own
form) as a document; past Telegram's 50 MB it stays on your computer, and the
reply says where. A reply
short enough to be a caption rides on the first file; a longer one comes first.

## Channels

Telegram and the web dashboard. Commands on both: `/model`, `/think`, `/access`,
`/stop`, `/compact`, `/reset`; on Telegram also `/status` (which shows the
chat's model, thinking level and access) and `/help`.

## Terminal chat

`pnpm chat` talks to Perry from the terminal, as a web chat that also shows in
the dashboard, using the dashboard key in `.env.local`. `--chat <id>` continues
a chat. The reply streams in place; Ctrl+C stops it and a second Ctrl+C exits.
`/new`, `/model [name]` and `/quit` work as you would expect, and each reply
ends with its time and tokens.

## Evals

Behaviour checks against the live Perry, modelled on
[eve](https://github.com/vercel/eve)'s evals. Each `evals/*.eval.ts` drives
fresh web chats and asserts on the replies and on which of Perry's tools ran;
`t.judge(...)` has Codex grade a reply with `codex exec` on your subscription.
Every eval deletes its chats, and anything it put in memory, when it ends. None
of them message Telegram.

```bash
pnpm evals                  # all of them
pnpm evals --tag memory     # those tagged memory
pnpm evals search-chats     # one, by its file name
pnpm evals --strict         # soft scores below their bar fail too
```

They need a runner started with `--auto`, since nobody is there to approve.
To keep them off your own runner, start a short-lived one and pass its token:

```bash
TOKEN=$(pnpm run -s connect -- --token-only --name evals | awk '/token/ {print $2}')
mkdir -p /tmp/perry-evals-work
# Its own PERRY_HOME, so your runner's saved settings are left alone.
PERRY_HOME=/tmp/perry-evals bun runner/index.ts --url http://127.0.0.1:3000 --token "$TOKEN" --dir /tmp/perry-evals-work --name evals --auto &
pnpm evals --runner-token "$TOKEN"
kill %1   # then revoke "evals" on the dashboard's Computer page
```

Results land in `artifacts/evals/<time>/`: `summary.json`, `results.jsonl` and
one file per eval with every turn.

Telegram replies stream as plain text and land formatted: the Markdown becomes
Telegram HTML (bold, italic, code, code blocks, links), sent as plain text if
Telegram refuses it. When Telegram says to slow down, a call waits as asked
and tries again, twice at most. `TELEGRAM_API_BASE` (in `.env.local`, unset
normally) points the bot at a stand-in Bot API; `artifacts/telegram-delivery`
uses it to test delivery without messaging anyone.

## Stack

| Layer | Choice |
|---|---|
| State, memory, scheduling, HTTP | SQLite (`node:sqlite`) in Perry's server, on a Convex-style runtime (`server/`) |
| Thinking and doing | Codex CLI on your ChatGPT subscription, via its app-server protocol |
| Your machine | The runner (`runner/`, Bun) |
| Connected accounts | [Composio](https://composio.dev) |
| Dashboard | Next.js |
| Chat | Telegram, web |

Packages in use: `convex` (only its validators and types, which the backend
functions are written with), `@composio/core`, `cron-parser`, `react-markdown`
with `remark-gfm` and `remark-breaks`, `turndown` and `undici` (reading pages)
and `zod`.

## Status

Done: Telegram and web chat with separate sessions, branching, search,
regenerate and edit; Codex as the engine with a per-chat model; streaming,
Markdown and stop; runner approvals from the dashboard and Telegram, with
saved rules and an automatic reviewer; connected accounts over
MCP; layered memory and chat search; local media and Telegram media; scheduled
jobs, one-time reminders and the heartbeat; skills.

Open work is tracked in [issues](https://github.com/TheM1N9/perry/issues),
among them automatic daily summaries into memory, durable turns and a browser for
the agent.

## Handing Perry to someone else

Send them the repo. `perry setup` gives them their own Perry on their own
computer, with separate everything, and nothing routine requires editing code.
Your data stays on your computer and is never visible to theirs.

What is not built: multiple people on one Perry. The dashboard key is a
bearer token for one owner, and memories are a single shared pool with no
per-user scoping. Making Perry multi-tenant means replacing that key with
real accounts and adding an owner id to `memories`, `conversations` and `runs`.
Every public function already checks authorisation in the same place, so that
change is contained, but it is a real change rather than a config switch.

## Channel notes

Telegram is the right first channel. Webhooks suit serverless, file limits are
generous, and there is no business verification.

WhatsApp is out. In January 2026 Meta banned open-ended AI assistant bots on the
Business Platform, allowing only structured flows. The unofficial Baileys route
works but carries a real ban risk on your personal number.

Slack works over HTTP events with `@vercel/slack-bolt`. Socket Mode is
incompatible with serverless. Discord works over the HTTP interactions endpoint;
the gateway is only needed for passive message reading.
