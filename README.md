# Perry

A personal AI assistant that lives in your chat app, remembers you, acts on your
accounts, and runs code in a disposable sandbox. Inspired by OpenClaw, but
cloud-native and built so the agent never touches a machine you care about.

Single-user by design. This is built for one owner, not for everyone.

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
| Tool allowlist | read and recall only | full, including exec and send |
| Step budget | 4 | 40 |
| Approval policy | never needed | confirm on write and send |
| Model | small and fast | frontier |

Because a mode is just data, adding more later is a config entry, not a refactor.
Obvious future ones: a focus mode that suppresses all proactive messages, and a
build mode pinned to the sandbox with no SaaS access at all.

The transition is the fun part. Asking for something that needs a tool Perry does
not have should not fail. It should surface as an offer to put the hat on.

## Stack

| Layer | Choice | Role |
|---|---|---|
| Brain and state | Convex | Threads, messages, memory, durable workflows, crons |
| Edge and ingress | Vercel | Channel webhooks, dashboard, AI Gateway |
| Hands | Composio | Gmail, Calendar, Notion, GitHub, Linear via OAuth |
| Sandbox | Daytona | Shell, code exec, browser, file work |
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
- **No long-lived exposed daemon.** Ingress is a stateless Vercel function with
  signature verification. State lives in Convex.
- **Single tenant.** One owner, allowlisted chat IDs, everything else dropped.
- **Least privilege by default.** Perry mode cannot do damage. Agent P is opt-in
  per task, not a standing grant.
- **Durable, inspectable state.** Every message, tool call and result is a Convex
  document you can query, not a process in memory.

## Architecture

```
Telegram --> Vercel fn (verify + enqueue) --> Convex mutation
                                                  |
                                    Convex Workflow (durable steps)
                                                  |
                                      Convex Agent loop + mode
                                       (AI SDK + AI Gateway)
                                     /            |            \
                              Composio         Daytona      Convex RAG
                            (SaaS tools)     (code/shell)    (memory)
                                                  |
                                    reply --> Telegram sendMessage
```

The Vercel function does nothing but verify the webhook signature and hand the
update to Convex, so it returns in milliseconds and never holds the agent loop.
The loop itself runs as a Convex workflow, which means a deploy, crash or timeout
resumes from the last completed step instead of losing the turn.

The active mode is resolved once at the top of the workflow and decides which
tools get bound, what the step budget is, and which model is used. Nothing
downstream can widen it mid-turn.

### Packages

```
@convex-dev/agent        threads, messages, tool-call history
@convex-dev/workflow     durable multi-step execution
@convex-dev/rag          per-user memory namespaces
ai                       AI SDK v6 loop (ToolLoopAgent)
@composio/core           tool router sessions
@composio/vercel         AI-SDK-shaped tools
@daytona/sdk             sandboxes  (NOT @daytonaio/sdk, deprecated)
grammy                   Telegram
```

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

## Build order

1. Telegram webhook to Convex, echo a reply. Proves ingress and auth.
2. Agent component with AI Gateway and streaming, no tools. Proves the loop.
3. Mode config and resolution, with Perry as the only mode. Proves the boundary.
4. Memory: `remember` and `recall` tools over the RAG component.
5. Composio tool router session, connect Gmail and Calendar.
6. Daytona sandbox tools: `exec`, `write_file`, `read_file`.
7. Agent P mode plus the approval prompt and the mode-switch offer.
8. Convex Workflow wrapping the loop for durability and retries.
9. Heartbeat cron plus agent-authored jobs.
10. Next.js dashboard on Vercel for threads, memories and connections.
11. Second channel: Discord HTTP interactions.

## Channel notes

Telegram is the right first channel. Webhooks suit serverless, voice notes come
free, file limits are generous, and there is no business verification.

WhatsApp is out. In January 2026 Meta banned open-ended AI assistant bots on the
Business Platform, allowing only structured flows. The unofficial Baileys route
works but carries a real ban risk on your personal number.

Slack works over HTTP events with `@vercel/slack-bolt`. Socket Mode is
incompatible with serverless. Discord works over the HTTP interactions endpoint;
the gateway is only needed for passive message reading.
