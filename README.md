# Perry

A personal AI assistant that lives in your chat app and your browser, remembers
you, acts on your connected accounts, and works on your own machine. It thinks
with your ChatGPT subscription, through the Codex CLI. Inspired by OpenClaw.

One install, one owner. Anyone can run their own copy, and every copy is
separate: its own deployment, its own bot, its own keys, its own memory. There
is no shared server and nothing here phones home.

```bash
pnpm install
pnpm run setup
```

The scripts and the runner need [Bun](https://bun.sh), and the assistant needs
the [Codex CLI](https://github.com/openai/codex) signed in with a ChatGPT
account. See [INSTALL.md](INSTALL.md).

## How it works

```
Telegram ─┐
          ├─> Convex (state, memory, scheduling, MCP tools) ─> runner on your machine ─> Codex
Web chat ─┘                                                    (dials out, never listens)
```

- **Convex** is the brain's memory and plumbing: chats, messages, memory, tasks,
  jobs, approvals and every run, as documents you can query. Telegram posts to
  a Convex HTTP action that verifies the webhook secret; the web dashboard talks
  to Convex directly.
- **The runner** (`pnpm run runner`) is a process on your machine. It dials out
  to Convex and holds a subscription; nothing listens on a port, so the machine
  cannot be found from the internet. It runs one process per token.
- **Codex** does the thinking and the work. Each chat turn becomes a Codex turn
  on the runner, in a workspace folder you chose, with your model of choice.
  Codex has a shell and file access there under its sandbox, and reaches
  Perry's own tools over MCP.

A turn: the message is stored, memory and recent history are gathered, the turn
is queued for the runner, Codex writes the reply (streamed live to the web chat
and into a single Telegram message), and the finished reply is saved.

## What the assistant can do

Codex brings its own shell, files, image generation and plugins. Perry adds its
tools over MCP (`convex/mcp.ts`), served only while the runner has a turn
running:

| Tool | What it does |
|---|---|
| `recall` `remember` `read_memory` `forget` | Layered memory: profile, long-term, daily notes |
| `search_chats` `read_chat` | Search and read earlier conversations, on every channel |
| `list_connectors` `find_action` `run_action` | Your connected accounts, through Composio |
| `start_task` `set_plan` `finish_task` `status_report` `set_goal` | Work that outlives the message |
| `watch_page` `read_page` | Recurring page checks, and reading public pages |
| `create_job` `list_jobs` `delete_job` | Scheduled prompts in your timezone |
| `share_file` | Show a file from your machine in the chat |

Connected accounts are looked up at the moment of use, never baked in: link
Google Calendar in the dashboard and the next turn can use it. Perry never holds
a token; Composio keeps the OAuth.

## You stay in control

- **Approvals.** Whatever Codex or the runner wants to do beyond its sandbox is
  asked in the runner's terminal and in the dashboard at once; the first answer
  wins, and an unanswered request is declined after ten minutes. `--auto` skips
  asking but still records what ran.
- **Stop.** A running reply can be stopped from the chat or with `/stop`; what
  it had written is kept.
- **Regenerate and edit.** Rewrite a reply, or change a message you sent and
  resend it; Codex starts from the history as it now stands.
- **Models.** Pick a Codex model per chat in the composer, or with `/model`.
- **Receipts.** Every turn is a run in the Activity page, with its model, tools,
  tokens and errors, and a trace of what Codex did: each command, file change,
  tool call and search on a timeline, with its input, output and status.

Tool output, web pages and account data are treated as untrusted data in the
instructions, and consequential actions (sending, deleting, publishing,
spending) are to be confirmed in chat first.

## Memory

Modelled on OpenClaw's workspace memory, in Convex:

- **Profile** (like `USER.md`): standing preferences and relationships, as
  directives. Loaded into every turn.
- **Long-term** (like `MEMORY.md`): durable facts and decisions. Loaded into
  every turn, within a budget.
- **Daily notes** (like `memory/YYYY-MM-DD.md`): today's and yesterday's load;
  older days are found by search, with a 30-day half-life on their ranking.

A fact that changes is superseded, not deleted. Chat history is separate and
searchable by the agent with `search_chats`.

Memory keeps itself current, like OpenClaw's memory flush and dreaming: the
built-in **daily summary** job (22:30) reads the day's chats and writes what is
worth keeping as daily notes, and **memory consolidation** (03:00) promotes
what the last week's notes show to be durable into the profile and long-term
memory. Both work quietly.

## Proactivity

Jobs are prompts on a cron schedule in your timezone (reported by the
dashboard), run as Codex turns. Each has a chat where its results collect, and
a result is also sent to you on Telegram. The built-in **heartbeat** looks over
tasks, goals, watches and recent memory a few times a day and speaks only when
something needs you; a reply of `NOTHING` stays silent. Ask the assistant for a
job ("every weekday at 8, brief me on my calendar") and it creates one.

## Media

Files stay on your machine. Attachments land in `~/.perry/uploads`, the agent
keeps what it makes wherever it decides (usually `~/.perry/files`), and the
dashboard's own server serves each file from where it is, only to the holder of
the dashboard key. Telegram photos, voice notes and documents are downloaded
and attached like any upload. Codex cannot hear audio, so voice notes need a
speech-to-text tool on the machine.

## Channels

Telegram and the web dashboard. Commands on both: `/model`, `/stop`; on
Telegram also `/status`, `/reset`, `/help`.

## Stack

| Layer | Choice |
|---|---|
| State, memory, scheduling, HTTP | [Convex](https://convex.dev) |
| Thinking and doing | Codex CLI on your ChatGPT subscription, via its app-server protocol |
| Your machine | The runner (`runner/`, Bun) |
| Connected accounts | [Composio](https://composio.dev) |
| Dashboard | Next.js |
| Chat | Telegram, web |

Packages in use: `convex`, `@convex-dev/agent` (threads and messages),
`@composio/core`, `cron-parser`, `react-markdown` with `remark-gfm` and
`remark-breaks`, `turndown` and `undici` (reading pages) and `zod`. `@daytona/sdk` backs cloud-sandbox tools that Codex does not use; it has its own shell on your machine.

## Status

Done: Telegram and web chat with separate sessions, branching, search,
regenerate and edit; Codex as the engine with a per-chat model; streaming,
Markdown and stop; runner approvals from the dashboard; connected accounts over
MCP; layered memory and chat search; local media and Telegram media; scheduled
jobs and the heartbeat.

Open work is tracked in [issues](https://github.com/TheM1N9/me-bot/issues),
among them automatic daily summaries into memory, durable turns, a browser for
the agent, and a permission model for what the agent may do.

## Handing Perry to someone else

Send them the repo. `pnpm run setup` builds them a separate deployment with
separate everything, and nothing routine requires editing code. Your data stays
on your deployment and is never visible to theirs.

What is not built: multiple people on one deployment. The dashboard key is a
bearer token for one owner, and memories are a single shared pool with no
per-user scoping. Making Perry multi-tenant means replacing that key with
Convex Auth and adding an owner id to `memories`, `conversations` and `runs`.
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
