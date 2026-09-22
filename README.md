# Perry

A personal AI assistant that lives in your chat app, remembers you, acts on your
accounts, and runs code in a disposable sandbox. Inspired by OpenClaw, but
cloud-native and built so the agent never touches a machine you care about.

One install, one owner. Anyone can run their own copy, and every copy is
separate: its own deployment, its own bot, its own keys, its own memory. There
is no shared server and nothing here phones home.

```bash
pnpm install
pnpm run setup
```

Five prompts, then send the pairing code it prints to your bot. See
[INSTALL.md](INSTALL.md).

## Modes

Perry has two personalities, and the joke is load-bearing. A mode is not flavor
text, it is the security and cost boundary of a turn.

**Perry** is the pet. Ambient, cheap, quiet. Answers when spoken to, reads
things, remembers things, and never touches anything that can cause damage. This
is the default and it is where most turns should live.

**Agent P** is the spy. Full tool access, sandbox, multi-step autonomy, and the
ability to write, send and deploy. Entered explicitly, on a leash, and it reports
back when done.

A mode is a config object with four knobs:

| Knob | Perry | Agent P |
|---|---|---|
| Tools | 4, all read-only | 15, including shell and file writes |
| Step budget | 6 | 40 |
| Approval policy | never needed | confirm on destructive and outward-facing |
| Model | Haiku 4.5 | Sonnet 5 |

The defaults live in `convex/modes.ts`, which is the one file to read to know
what Perry is allowed to do. The dashboard can override any of them per mode,
stored in the database and merged over the defaults at the top of each turn, so
handing Perry to someone else does not hand them a TypeScript file to edit.
Clearing a field restores the shipped value.

Because a mode is just data, adding more later is a config entry, not a refactor.
Obvious future ones: a focus mode that suppresses all proactive messages, and a
build mode pinned to the sandbox with no SaaS access at all.

The transition is the fun part. Asking for something that needs a tool Perry does
not have should not fail. It should surface as an offer to put the hat on.

## What Agent P can do

The tool surface is modelled on OpenMuse, whose split between a private
computer, durable work and read-only sources is the right one.

| Tool | What it does |
|---|---|
| `run_command` | One bash command in a private Linux sandbox. 30s cap, output capped. |
| `read_file` `write_file` `list_files` | /workspace, 256 KB per file, persists between commands. |
| `computer_status` | Whether a sandbox exists and is running. |
| `read_page` | Fetch a public page as text. No JavaScript, no login. |
| `list_connectors` | Which accounts the owner has linked through Composio. |
| `find_action` `run_action` | Look up and run an operation on a linked account. |
| `start_task` `set_plan` `finish_task` | Open a job, keep a checklist current, close it with a result. |
| `status_report` | Read back current tasks, goals and watches. |
| `set_goal` | An outcome with milestones. |
| `watch_page` | Recurring check: changed, contains text, or price below a number. |
| `recall` `remember` `forget` | Long-term memory. |

Perry mode gets five: `recall`, `remember`, `read_page`, `status_report` and
`list_connectors`. It can see which accounts are linked but cannot use them,
and nothing in that set changes anything outside memory.

Connected accounts are looked up at the moment of use, never baked in. Link
Google Calendar in the dashboard and the next turn can create events, with no
redeploy and no code change. Unlink it and the ability disappears the same way.
Perry never holds a token: Composio keeps the OAuth and this deployment holds
one key that can act only on accounts you linked.

Three rules carried over from OpenMuse, because the reasoning holds:

- **No credentials in the sandbox.** Nothing there can leak a token, because no
  token is ever put there.
- **Receipts, not retries.** Every command carries an `operationId`. Asking
  twice with the same id returns the first receipt instead of running again, so
  an interrupted command is never silently repeated.
- **Output is data, never instructions.** Command output, file contents and web
  pages are framed as untrusted in the prompt, because prompt injection through
  a fetched page is the obvious attack on an agent that reads the web.

One deliberate difference: OpenMuse disables networking inside its container
and browses in a separate worker. Perry leaves the sandbox network on, because
without it the sandbox cannot install a package or clone a repo, which is most
of what it is for. That widens the blast radius, and is why the sandbox is bound
to Agent P alone.

Tasks, goals and watches live in the database rather than the conversation. Ask
an agent what it is doing and it will reconstruct a plausible answer; the Work
tab shows what it actually wrote down.

## Stack

| Layer | Choice | Role |
|---|---|---|
| Brain and state | Convex | Threads, messages, memory, durable workflows, crons |
| Edge and ingress | Vercel | Channel webhooks, dashboard, AI Gateway |
| Hands | Composio | Gmail, Calendar, Notion, GitHub, Linear via OAuth |
| Sandbox | Daytona | Shell, code exec, file work |
| Your machine | A runner you start | The same, on your own files |
| Channel | Telegram first | Discord and Slack next |

## Why this shape

OpenClaw is a stateful Node process on your own hardware with shell, browser and
credential access, and sandboxing that is opt-in. That design produced the first
big agent security crisis of 2026: 512 vulnerabilities in a January audit,
CVE-2026-25253 at CVSS 8.8, 135k exposed instances found by internet scanning,
12,812 of them remotely exploitable, plus roughly 335 malicious skills on
ClawHub.

Perry inverts each of those choices:

- **No host shell.** Every command runs inside an ephemeral Daytona sandbox.
- **No raw credentials in the agent.** Composio holds OAuth tokens per connected
  account; the agent only gets scoped tool handles.
- **No long-lived exposed daemon.** Ingress is one stateless HTTP action that
  verifies a webhook secret in constant time. Nothing runs between messages.
- **One owner, proved by a pairing code.** Not an environment variable and not
  whoever messages first. Once claimed, every other sender is dropped without a
  reply.
- **Least privilege by default.** Perry mode cannot do damage. Agent P is opt-in
  per task, not a standing grant.
- **Durable, inspectable state.** Every message, tool call and result is a Convex
  document you can query, not a process in memory.

## Architecture

```
Telegram --> Convex HTTP action (verify + enqueue) --> ingest mutation
                                                  |
                                          scheduled action
                                                  |
                                      Convex Agent loop + mode
                                       (AI SDK + AI Gateway)
                                     /            |            \
                              Composio         Daytona      Convex RAG
                            (SaaS tools)     (code/shell)    (memory)
                                                  |
                                    reply --> Telegram sendMessage
```

Ingress verifies the webhook secret, hands the update to a mutation, and returns
200 in milliseconds. The turn itself is scheduled and runs after that returns,
which matters because a slow response makes Telegram retry and deliver the same
message twice.

The original plan put a Vercel function in front of this. It bought nothing: the
Convex HTTP endpoint is already HTTPS on a stable domain and the handler has to
reach Convex anyway, so the hop would have added a second shared secret and a
cold start. Vercel keeps the dashboard and the AI Gateway.

Once turns get long enough to be worth checkpointing, the scheduled action
becomes a Convex workflow and a crash mid-turn resumes from the last completed
step instead of losing it.

The active mode is resolved once at the top of the workflow and decides which
tools get bound, what the step budget is, and which model is used. Nothing
downstream can widen it mid-turn.

### Packages

In use today:

```
convex                      1.46   backend, HTTP actions, scheduler
@convex-dev/agent           0.7.3  threads, messages, tool-call history
@convex-dev/ai-sdk-provider 0.2    keyless Convex gateway
ai                          7.0    AI SDK, tool loop
zod                         4.6    tool input schemas
```

Models are `provider/model` strings, and which gateway resolves them depends on
what the installer had to sign up for.

With a Vercel AI Gateway key set, the slug is passed straight through and the
AI SDK resolves it. That sidesteps pinning a second copy of `@ai-sdk/provider`
and matching its specification version to the one the Agent component demands,
which is a version-skew argument nobody wins.

Without a key, Convex's own gateway resolves it instead. That one needs no key
but is only enabled on paid Convex plans, so it is a fallback rather than a
free-tier escape hatch. Neither gateway marks up token prices.

Planned, not installed yet:

```
@convex-dev/workflow     durable multi-step execution
@convex-dev/rag          embeddings for memory, replacing full-text search
@composio/core           tool router sessions
@daytona/sdk             sandboxes  (NOT @daytonaio/sdk, deprecated)
```

No Telegram library. Perry never polls and never runs a handler loop, so inbound
is one HTTP action and outbound is one POST. A framework there would be weight
without leverage.

## Memory model

Three tiers, all in Convex:

1. **Thread history** stored by the Agent component, windowed into context.
2. **Durable facts** in a `memories` table, written by a `remember` tool the
   agent calls explicitly, retrieved by hybrid vector plus text search.
3. **Daily log** appended per day, summarized by a nightly cron so the agent can
   answer "what did I do last week" without replaying raw history.

The RAG component handles embeddings, so there is no separate vector database.
Memory is shared across modes. Agent P remembers what Perry was told.

## Proactivity

Two mechanisms, backed by Convex crons:

- **Heartbeat.** One scheduled tick that wakes Perry with recent context and lets
  it decide whether anything is worth surfacing. Silence is a valid answer, and
  the heartbeat always runs in Perry mode.
- **Jobs.** Named cron entries the agent creates for itself, such as a morning
  briefing or a Friday inbox sweep. A job can request Agent P, which is exactly
  the case that needs an approval prompt rather than silent execution.

## Sandbox policy

One Daytona sandbox per owner, created from a snapshot with the usual tooling
preinstalled. Auto-stop after 15 minutes idle keeps cost near zero; a mounted
volume keeps the working directory across restarts. Long jobs run detached and
call back into a Convex HTTP action when they finish, so no function sits and
waits.

## Cost at rest

| Service | Free allowance |
|---|---|
| Convex | 1M function calls/mo, 0.5 GB |
| Composio | 100k tool calls/mo, 50k triggers |
| Daytona | $200 signup credit, per-second billing |
| Vercel AI Gateway | $5 credit/mo, no markup on tokens |

Model tokens are the only real line item. Defaulting to Perry mode on a small
model is what keeps that number boring.

## Status

Done:

1. Telegram webhook to Convex, owner allowlist, commands. Ingress and auth.
2. Agent loop on the Agent component through a gateway. The turn.
3. Both modes, resolved once per turn and enforced by tool binding.
4. Memory: `recall`, `remember`, `forget` over Convex full-text search.
5. Runtime config. Model, step budget, tools and instructions per mode, stored
   in the database and editable without a redeploy.
6. Web channel with separate chat sessions, branching, search, and shared
   memory with Telegram.
7. Dashboard: chat management, memory editing, mode config, and a log of every
   turn with its tools, tokens and errors.

[INSTALL.md](INSTALL.md) has the detail. `pnpm run doctor` checks it.

8. Daytona sandbox: shell, files, receipts. Agent P only.
9. Reading public pages, with the private-network addresses refused.
10. Tasks with live plans, goals with milestones, recurring page watches.
11. Work tab in the dashboard, and a cron that checks watches every 5 minutes.

Next:

12. Composio tool router: linked accounts become tools without a redeploy.
13. Run commands on your own machine instead of the sandbox, through a
    runner that dials out and never listens on a port.

Next:

14. Approval gate: propose, expire, decide, before anything destructive.
14. A real browser with persistent profiles, for pages that need JavaScript.
15. Swap full-text memory for `@convex-dev/rag` embeddings.
16. Convex Workflow wrapping the turn for durability and retries.
17. Heartbeat cron plus agent-authored jobs.
18. Second channel: Discord HTTP interactions.

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

Telegram is the right first channel. Webhooks suit serverless, voice notes come
free, file limits are generous, and there is no business verification.

WhatsApp is out. In January 2026 Meta banned open-ended AI assistant bots on the
Business Platform, allowing only structured flows. The unofficial Baileys route
works but carries a real ban risk on your personal number.

Slack works over HTTP events with `@vercel/slack-bolt`. Socket Mode is
incompatible with serverless. Discord works over the HTTP interactions endpoint;
the gateway is only needed for passive message reading.
