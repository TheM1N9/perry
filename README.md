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
account. The runner works on macOS, Linux and Windows, in a terminal or as a
background service (`pnpm run service install`). See [INSTALL.md](INSTALL.md)
for each OS.

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
  cannot be found from the internet. It runs one process per token, in a
  terminal or under the OS's own service manager (launchd, systemd or Task
  Scheduler).
- **Codex** does the thinking and the work. Each chat turn becomes a Codex turn
  on the runner, in a workspace folder you chose, with your model of choice.
  Codex has a shell and file access there under its sandbox (Seatbelt on
  macOS, bubblewrap on Linux, a restricted token on Windows), is told which OS
  and shell it is on, and reaches Perry's own tools over MCP.

A turn: the message is stored, memory and recent history are gathered, the turn
is queued for the runner, Codex writes the reply (streamed live to the web chat
and into a single Telegram message), and the finished reply is saved.

**When the computer is offline.** Off by default. Turn on "Answer without the
computer when it's offline" in Settings and a turn no runner can take is
answered in Convex instead (`convex/fallback.ts`), on the same ChatGPT
subscription, through the Codex backend the CLI uses (the transport is adapted
from [vercel/eve](https://github.com/vercel/eve)). It has Perry's own tools
(memory, earlier chats, connected accounts, jobs, tasks, page reading) but no
shell, files or `share_file`. The reply streams like any other, its run is
marked `chatgpt fallback · <model>`, and the chat notes it was answered without
your computer. For this, each runner shares the ChatGPT access token its Codex
holds (read with the app-server's `getAuthStatus`; Codex keeps and uses the
refresh token). **The risk:** that token sits in your Convex deployment until
it expires, so anyone who can read the deployment's data could use your
subscription until then. It is never returned by a dashboard query, and it is
deleted when it expires, when its runner is revoked and when you turn the
setting off.

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
| `create_job` `list_jobs` `update_job` `delete_job` | Scheduled prompts and one-time reminders in your timezone |
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

Modelled on OpenClaw's workspace memory, in Convex:

- **Profile** (like `USER.md`): standing preferences and relationships, as
  directives. In every turn's instructions.
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
memory. Both work quietly.

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
Convex storage and sent as a real file: photos, GIFs, videos, audio and voice
notes as themselves, anything else (or anything Telegram refuses in its own
form) as a document, and past Telegram's 50 MB as a download link. A reply
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
TOKEN=$(bun -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
RUNNER=$(pnpm exec convex run runner:createToken "{\"name\":\"evals\",\"token\":\"$TOKEN\"}" 2>/dev/null | tail -1 | tr -d '"\r')
mkdir -p /tmp/perry-evals-work
# Its own PERRY_HOME, so your runner's saved settings are left alone.
PERRY_HOME=/tmp/perry-evals bun runner/index.ts --url <your Convex URL> --token "$TOKEN" --dir /tmp/perry-evals-work --name evals --auto &
pnpm evals --runner-token "$TOKEN"
kill %1; pnpm exec convex run runner:revokeRunner "{\"runnerId\":\"$RUNNER\"}"
```

Results land in `artifacts/evals/<time>/`: `summary.json`, `results.jsonl` and
one file per eval with every turn.

Telegram replies stream as plain text and land formatted: the Markdown becomes
Telegram HTML (bold, italic, code, code blocks, links), sent as plain text if
Telegram refuses it. When Telegram says to slow down, a call waits as asked
and tries again, twice at most. `TELEGRAM_API_BASE` (a Convex env var, unset
normally) points the bot at a stand-in Bot API; `artifacts/telegram-delivery`
uses it to test delivery without messaging anyone.

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
`ai` with `@ai-sdk/openai` (answering without the computer),
`@composio/core`, `cron-parser`, `react-markdown` with `remark-gfm` and
`remark-breaks`, `turndown` and `undici` (reading pages) and `zod`. `@daytona/sdk` backs cloud-sandbox tools that Codex does not use; it has its own shell on your machine.

## Status

Done: Telegram and web chat with separate sessions, branching, search,
regenerate and edit; Codex as the engine with a per-chat model; streaming,
Markdown and stop; runner approvals from the dashboard and Telegram, with
saved rules and an automatic reviewer; connected accounts over
MCP; layered memory and chat search; local media and Telegram media; scheduled
jobs, one-time reminders and the heartbeat; skills.

Open work is tracked in [issues](https://github.com/TheM1N9/me-bot/issues),
among them automatic daily summaries into memory, durable turns and a browser for
the agent.

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
