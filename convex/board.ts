import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { describeStep } from "./lib/activity";
import type { EngineKind } from "./lib/engines";
import { turnHealth } from "./lib/turn-health";
import { citedMemories } from "../lib/reply-text";
import { APPROVAL_TTL_MS, BRAIN_TTL_MS } from "./approvals";
import { STOPPED } from "./codex";
import { QUIET } from "./jobs";
import { boardLink } from "../lib/board-links";

/**
 * The Board (issue #363): what Perry is doing, read from what it already
 * keeps. Each piece of work is a thread (a background task, a schedule, the
 * heartbeat, a page watch, or one turn of a chat), filed in a channel by its
 * kind and its project, with who holds it (engine, model, computer), how it
 * stands, and a feed of what it did. Nothing here writes; answering and
 * approving stay on the pages that already do them.
 */

export type BoardStatus = "queued" | "working" | "waiting" | "blocked" | "done" | "failed";
export type BoardKind = "chat" | "task" | "job" | "heartbeat" | "watch" | "goal" | "agent";
export type BoardHolder = { engine?: EngineKind; model?: string; machine?: string };

export type BoardThread = {
  /** "<kind>:<id>": task:…, job:…, run:… (a chat turn) or watch:…. */
  id: string;
  kind: BoardKind;
  title: string;
  /** What it was asked to do. */
  ask: string;
  status: BoardStatus;
  /** The status as its own page words it: "Needs you", "Paused", "Stopped". */
  label: string;
  holder?: BoardHolder;
  startedAt: number;
  updatedAt: number;
  /** Set once it is over, for how long it took. */
  finishedAt?: number;
  /** The step it is on, or how it ended, in a line. */
  now?: string;
  /** What a task stopped to ask the owner, answered on its own page. */
  question?: string;
  /** A queued task's place in line: 1 is next. Tasks start oldest first. */
  inLine?: number;
  /** When a schedule runs next, while it is on and runs by the clock. */
  nextAt?: number;
  projectId?: Id<"projects">;
  chatId?: Id<"conversations">;
  /** A sub-agent's: the thread whose turn started it (a chat turn, a task or a schedule), which it is listed under. */
  parent?: string;
  /** Its address on the Board: its channel, with it open. */
  href: string;
};

export type BoardVerb = "queued" | "started" | "posted" | "asked" | "approval" | "finished" | "failed" | "stopped" | "fired";
/** `status`: how its thread stood with this event, where the event says so (a failure is failed for good). */
export type BoardEvent = {
  id: string; thread?: string; at: number; verb: BoardVerb; status?: BoardStatus; text?: string; machine?: string; href?: string;
  /** A sub-agent's event, told on its parent's thread: the agent's own thread and title. */
  agent?: { id: string; title: string };
};

/**
 * Something waiting on the owner: an approval a computer asked for, or a task's question. Each names the thread it
 * holds up, which the board then leaves out of its list, so the item is shown once.
 */
export type BoardWaiting = {
  id: string; kind: "approval" | "question"; text: string; where?: string; thread?: string; href: string; at: number;
  /** The text is a command, shown as code. */
  command?: boolean;
};

export type BoardView = {
  threads: BoardThread[];
  waiting: BoardWaiting[];
  events: BoardEvent[];
  projects: Array<{ id: Id<"projects">; name: string }>;
  machines: Array<{ name: string; online: boolean }>;
};

/**
 * A thread's feed, oldest first. A turn's own steps, updates and files are the
 * chat's timeline of it (dashboard.getRunSteps), read where it is shown.
 */
export type FeedItem =
  | {
    kind: "run"; id: string; runId: Id<"runs">; at: number; holder?: BoardHolder; status: BoardStatus; label: string; endedAt?: number;
    /** Its reply, when the thread ends with it as the result: the timeline leaves it out rather than say it twice. */
    omit?: string;
  }
  | { kind: "update"; id: string; at: number; text: string }
  | { kind: "said"; id: string; at: number; text: string }
  | { kind: "approval"; id: string; at: number; text: string; href: string }
  | { kind: "question"; id: string; at: number; text: string; href: string }
  /** `reply`: a chat turn's answer, rather than a task's or a schedule's result. */
  | { kind: "result"; id: string; at: number; text: string; reply?: true }
  /** `step`: the last thing it did before it failed, so a failure says where without opening its steps. */
  | { kind: "error"; id: string; at: number; text: string; step?: string };

export type ThreadView = {
  thread: BoardThread; plan?: Doc<"tasks">["plan"]; feed: FeedItem[];
  /** A parent's sub-agents, oldest first. */
  agents?: BoardThread[];
  /** A sub-agent's: the thread it belongs to, and what it has written so far (its output, once it is over). */
  parent?: { id: string; title: string; holder?: BoardHolder };
  output?: string;
};

/** Chat turns read for the board: enough for a few days of an active owner. */
const RUNS = 120;
/** Tasks that are over, newest first, beside every one still going. */
const ENDED_TASKS = 30;
/** Events on the rail. */
const EVENTS = 150;
/** Turns of a task, and runs of a schedule, a thread's feed shows. */
const TASK_RUNS = 6;
const JOB_RUNS = 3;
/** A run with no turn behind it this long after it started was cut off (a restart mid-turn). */
const ORPHAN_MS = 30 * 60_000;
const ONLINE_MS = 90_000;
/** Sub-agents read under one chat: a turn rarely starts more than a handful. */
const AGENTS = 50;

/** A text's first line as plain words, for a one-line summary: Markdown's marks and a link's address left out. */
const firstLine = (text: string | undefined, max = 160) => {
  const line = (text?.trim().split("\n").find((part) => part.trim()) ?? "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "").replace(/^\s*(?:#+|[-*>]|\d+\.)\s+/, "").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line || undefined;
};
/** The newest event of each thread (or of an approval with none), newest first. */
function latestEach(events: BoardEvent[]): BoardEvent[] {
  const seen = new Set<string>();
  return [...events].sort((a, b) => b.at - a.at).filter((event) => {
    const key = event.thread ?? event.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Whether a watch's last observation is the one that fired it: each check keeps only its own, and a firing stays. */
const firedOn = (monitor: Doc<"monitors">) => monitor.firedAt !== undefined && Math.abs((monitor.lastCheckedAt ?? 0) - monitor.firedAt) < 1_000;
const PLACE: Record<FeedItem["kind"], number> = { run: 0, update: 1, said: 1, approval: 1, question: 2, result: 2, error: 2 };
const CONDITION: Record<Doc<"monitors">["condition"], string> = { change: "when anything changes", contains: "when it contains", price_below: "when the price drops below" };

/** What the board reads once per query and looks up many times. */
function loader(ctx: QueryCtx, now: number) {
  const chats = new Map<Id<"conversations">, Promise<Doc<"conversations"> | null>>();
  const turns = new Map<Id<"runs">, Promise<Doc<"codexTurns"> | null>>();
  let runners: Promise<Map<Id<"runners">, Doc<"runners">>> | undefined;
  let asking: Promise<Doc<"approvals">[]> | undefined;
  const chat = (id: Id<"conversations"> | undefined) => {
    if (!id) return Promise.resolve(null);
    if (!chats.has(id)) chats.set(id, ctx.db.get(id));
    return chats.get(id)!;
  };
  const turnOf = (runId: Id<"runs">) => {
    if (!turns.has(runId)) turns.set(runId, ctx.db.query("codexTurns").withIndex("by_run", (q) => q.eq("runId", runId)).first());
    return turns.get(runId)!;
  };
  const allRunners = () => runners ??= ctx.db.query("runners").collect().then((rows) => new Map(rows.map((row) => [row._id, row])));
  /** Approvals still waiting for the owner, as Needs you lists them. */
  const pending = () => asking ??= ctx.db.query("approvals")
    .withIndex("by_status", (q) => q.eq("status", "pending").gt("createdAt", now - BRAIN_TTL_MS))
    .collect()
    .then((rows) => rows.filter((row) => row.createdAt > now - (row.kind === "brain" ? BRAIN_TTL_MS : APPROVAL_TTL_MS)));
  const latestRun = (conversationId: Id<"conversations"> | undefined) => conversationId
    ? ctx.db.query("runs").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).order("desc").first()
    : Promise.resolve(null);

  async function holderOf(run: Doc<"runs">): Promise<BoardHolder> {
    const turn = await turnOf(run._id);
    const machine = turn?.runnerId ? (await allRunners()).get(turn.runnerId)?.name : undefined;
    const engine = run.route?.engine ?? turn?.engine;
    const model = run.model ?? run.route?.model ?? turn?.model ?? turn?.requestedModel;
    return { ...(engine ? { engine } : {}), ...(model ? { model } : {}), ...(machine ? { machine } : {}) };
  }

  /** How a run stands: a turn can wait in line, on the owner, or on a computer that went quiet. */
  async function runState(run: Doc<"runs">): Promise<{ status: BoardStatus; label: string }> {
    if (run.status === "ok") return { status: "done", label: "Done" };
    if (run.status === "rejected") return { status: "failed", label: "Rejected" };
    if (run.status === "error") return run.error === STOPPED ? { status: "done", label: "Stopped" } : { status: "failed", label: "Failed" };
    if ((await pending()).some((row) => row.conversationId === run.conversationId)) return { status: "waiting", label: "Needs you" };
    const turn = await turnOf(run._id);
    if (!turn) return now - run.startedAt > ORPHAN_MS ? { status: "failed", label: "Interrupted" } : { status: "working", label: "Working" };
    if (turn.status === "queued") return turn.waiting ? { status: "blocked", label: "Waiting for reset" } : { status: "queued", label: "Queued" };
    const runner = turn.runnerId ? (await allRunners()).get(turn.runnerId) ?? null : null;
    if (turn.status === "running" && turnHealth(turn, runner, now).unresponsive) return { status: "blocked", label: "Computer not responding" };
    return { status: "working", label: "Working" };
  }

  /** The step a running run is on, in the pet's words, and when its latest step began. */
  async function stepOf(run: Doc<"runs">): Promise<{ label: string; at: number }> {
    const latest = await ctx.db.query("runSpans").withIndex("by_run_started", (q) => q.eq("runId", run._id)).order("desc").take(6);
    const at = Math.max(run.startedAt, latest[0]?.startedAt ?? 0);
    const asking = (await pending()).find((row) => row.conversationId === run.conversationId);
    if (asking) return { label: "Waiting for you to approve", at: Math.max(at, asking.createdAt) };
    const span = latest.find((item) => item.kind !== "reasoning" && item.kind !== "plan");
    return { label: span ? describeStep(span, { done: span.status !== "running" }).label : "Thinking", at };
  }

  /** What a finished turn answered, in a line; what it did, when its reply is gone. */
  const replyOf = async (run: Doc<"runs">) => firstLine((await turnOf(run._id))?.response) ?? (run.summary || undefined);

  const projectOf = async (...ids: Array<Id<"conversations"> | undefined>) => {
    for (const id of ids) {
      const found = (await chat(id))?.projectId;
      if (found) return { projectId: found };
    }
    return {};
  };

  async function runThread(run: Doc<"runs">): Promise<BoardThread> {
    const conversation = await chat(run.conversationId);
    const state = await runState(run);
    const live = state.status === "working" || state.status === "waiting";
    const step = live ? await stepOf(run) : undefined;
    return {
      id: `run:${run._id}`,
      kind: "chat",
      title: conversation?.title ?? (conversation?.channel === "telegram" ? "Telegram" : conversation?.channel === "whatsapp" ? "WhatsApp" : "Untitled chat"),
      ask: run.prompt,
      ...state,
      holder: await holderOf(run),
      startedAt: run.startedAt,
      // A running turn changes as it takes each step, so the row's unread mark follows its steps.
      updatedAt: run.finishedAt ?? step?.at ?? run.startedAt,
      ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
      now: step ? step.label : state.status === "failed" ? firstLine(run.error) : await replyOf(run),
      ...await projectOf(run.conversationId),
      ...(conversation ? { chatId: conversation._id } : {}),
      href: `/chat/${run.conversationId}`,
    };
  }

  async function taskThread(task: Doc<"tasks">): Promise<BoardThread> {
    const run = await latestRun(task.conversationId);
    const active = task.plan.find((step) => step.status === "active")?.title;
    let state: { status: BoardStatus; label: string };
    let line: string | undefined;
    if (task.status === "queued") {
      const waiting = task.waiting && task.waiting.until > now;
      state = waiting ? { status: "blocked", label: "Waiting for reset" } : { status: "queued", label: "Queued" };
      line = waiting ? task.waiting!.why : undefined;
    } else if (task.status === "running") {
      state = run?.status === "running" ? await runState(run) : { status: "working", label: "Working" };
      if (state.status === "done" || state.status === "failed") state = { status: "working", label: "Working" };
      // In line or held up, it says nothing of a step; at work, the step it is on.
      line = state.status === "working" || state.status === "waiting" ? (run?.status === "running" ? (await stepOf(run)).label : active) : undefined;
    } else if (task.status === "blocked") {
      state = task.question ? { status: "waiting", label: "Needs you" } : { status: "blocked", label: "Blocked" };
      line = task.question;
    } else if (task.status === "failed") {
      state = { status: "failed", label: "Failed" };
      line = task.error;
    } else {
      state = { status: "done", label: task.status === "cancelled" ? "Cancelled" : "Done" };
      line = task.result;
    }
    const over = task.status === "done" || task.status === "failed" || task.status === "cancelled";
    const holder = run ? await holderOf(run) : task.route ? { engine: task.route.engine, ...(task.route.model ? { model: task.route.model } : {}) } : undefined;
    return {
      id: `task:${task._id}`,
      kind: "task",
      title: task.title,
      ask: task.prompt,
      ...state,
      ...(holder ? { holder } : {}),
      startedAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(over ? { finishedAt: task.updatedAt } : {}),
      now: firstLine(line),
      ...(task.status === "blocked" && task.question ? { question: task.question } : {}),
      ...await projectOf(task.conversationId, task.origin),
      ...(task.conversationId ? { chatId: task.conversationId } : {}),
      href: boardLink({ channel: "tasks", thread: `task:${task._id}` }),
    };
  }

  async function jobThread(job: Doc<"jobs">): Promise<BoardThread> {
    const run = await latestRun(job.conversationId);
    let state: { status: BoardStatus; label: string };
    let line: string | undefined;
    if (run?.status === "running") {
      state = await runState(run);
      line = state.status === "working" || state.status === "waiting" ? (await stepOf(run)).label : undefined;
    } else if (job.waiting) {
      state = { status: "blocked", label: "Waiting for reset" };
      line = job.waiting.why;
    } else if (job.lastError) {
      state = { status: "failed", label: "Failed" };
      line = job.lastError;
    } else if (!job.enabled) {
      state = { status: "done", label: job.runAt !== undefined && job.lastRunAt ? "Done" : "Paused" };
      line = job.lastResult;
    } else if (job.lastRunAt) {
      state = { status: "done", label: "Done" };
      line = job.lastResult;
    } else {
      state = { status: "queued", label: "Scheduled" };
    }
    if (line?.trim() === QUIET) line = "Nothing new";
    const holder = run ? await holderOf(run) : job.engine ? { engine: job.engine, ...(job.model ? { model: job.model } : {}) } : undefined;
    const startedAt = run?.startedAt ?? job.createdAt;
    const updatedAt = Math.max(job.lastRunAt ?? 0, run?.finishedAt ?? run?.startedAt ?? 0, job.createdAt);
    return {
      id: `job:${job._id}`,
      kind: job.builtin === "heartbeat" ? "heartbeat" : "job",
      title: job.name,
      ask: job.prompt,
      ...state,
      ...(holder ? { holder } : {}),
      startedAt,
      updatedAt,
      ...(run?.finishedAt !== undefined && run.status !== "running" ? { finishedAt: run.finishedAt } : {}),
      now: firstLine(line),
      ...(job.enabled && !job.trigger && run?.status !== "running" && job.nextRunAt > now ? { nextAt: job.nextRunAt } : {}),
      ...await projectOf(job.conversationId, job.origin),
      ...(job.conversationId ? { chatId: job.conversationId } : {}),
      href: boardLink({ channel: job.builtin === "heartbeat" ? "heartbeat" : "jobs", thread: `job:${job._id}` }),
    };
  }

  function watchThread(monitor: Doc<"monitors">): BoardThread {
    const state: { status: BoardStatus; label: string } = !monitor.active ? { status: "done", label: "Paused" }
      : monitor.failures > 0 ? { status: "failed", label: monitor.failures === 1 ? "Check failed" : `${monitor.failures} checks failed` }
        : { status: "working", label: "Watching" };
    return {
      id: `watch:${monitor._id}`,
      kind: "watch",
      title: monitor.title,
      ask: `Watch ${monitor.url} ${CONDITION[monitor.condition]}${monitor.value ? ` “${monitor.value}”` : ""}.`,
      ...state,
      startedAt: monitor.createdAt,
      updatedAt: Math.max(monitor.lastCheckedAt ?? 0, monitor.firedAt ?? 0, monitor.createdAt),
      now: firstLine(monitor.lastObservation),
      href: boardLink({ channel: "watches", thread: `watch:${monitor._id}` }),
    };
  }

  /** A goal: what the owner is after, with its milestones; always there, like a watch, until done or paused. */
  function goalThread(goal: Doc<"goals">): BoardThread {
    const reached = goal.milestones.filter((milestone) => milestone.done).length;
    const state: { status: BoardStatus; label: string } = goal.status === "active" ? { status: "working", label: "Active" }
      : { status: "done", label: goal.status === "paused" ? "Paused" : "Done" };
    return {
      id: `goal:${goal._id}`,
      kind: "goal",
      title: goal.title,
      ask: goal.description ?? goal.title,
      ...state,
      startedAt: goal.createdAt,
      updatedAt: goal.updatedAt,
      now: goal.milestones.length ? `${reached} of ${goal.milestones.length} milestones` : firstLine(goal.description),
      href: boardLink({ channel: "goals", thread: `goal:${goal._id}` }),
    };
  }

  /** The thread a chat's work belongs to: its task or schedule, else the turn itself. */
  async function threadIdOf(conversationId: Id<"conversations"> | undefined, runId?: Id<"runs">): Promise<string | undefined> {
    const conversation = await chat(conversationId);
    if (conversation?.taskId) return `task:${conversation.taskId}`;
    if (conversation?.jobId) return `job:${conversation.jobId}`;
    if (runId) return `run:${runId}`;
    const run = await latestRun(conversationId);
    return run ? `run:${run._id}` : undefined;
  }

  /**
   * A sub-agent a turn started (Claude's Agent or Task tool, Codex's spawned agents): the runner reports each in the
   * turn's trace, and codex.recordAgents keeps it as a chat of its own under the turn's chat, with `providerAgent`.
   */
  async function agentThread(conversation: Doc<"conversations">, parent: string): Promise<BoardThread> {
    const agent = conversation.providerAgent!;
    const state: { status: BoardStatus; label: string } = agent.status === "running" ? { status: "working", label: "Running" }
      : agent.status === "failed" ? { status: "failed", label: "Failed" } : agent.status === "cancelled" ? { status: "done", label: "Stopped" } : { status: "done", label: "Done" };
    const machine = conversation.codexRunnerId ? (await allRunners()).get(conversation.codexRunnerId)?.name : undefined;
    const lines = (agent.text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    return {
      id: `agent:${conversation._id}`,
      kind: "agent",
      title: conversation.title ?? "Agent",
      ask: agent.prompt ?? conversation.title ?? "",
      ...state,
      holder: { ...(conversation.engine ? { engine: conversation.engine } : {}), ...(conversation.model ? { model: conversation.model } : {}), ...(machine ? { machine } : {}) },
      startedAt: agent.startedAt,
      updatedAt: agent.updatedAt ?? agent.startedAt,
      ...(agent.finishedAt !== undefined ? { finishedAt: agent.finishedAt } : {}),
      // While it works, the last thing it wrote; failed, its last word (why); done, how its answer starts.
      now: firstLine(agent.status === "done" || agent.status === "cancelled" ? lines[0] : lines.at(-1)),
      parent,
      ...(conversation.projectId ? { projectId: conversation.projectId } : {}),
      href: boardLink({ thread: `agent:${conversation._id}` }),
    };
  }

  /** The sub-agents started in a chat (each turn's, a task's or a schedule's), each with the thread it belongs to. */
  async function agentsIn(conversationId: Id<"conversations"> | undefined): Promise<Array<{ conversation: Doc<"conversations">; parent?: string }>> {
    if (!conversationId) return [];
    const children = await ctx.db.query("conversations").withIndex("by_parent", (q) => q.eq("parentConversationId", conversationId)).order("desc").take(AGENTS);
    return Promise.all(children.filter((child) => child.providerAgent).map(async (conversation) => ({
      conversation, parent: await threadIdOf(conversationId, conversation.providerAgent!.runId),
    })));
  }

  return { chat, turnOf, allRunners, pending, latestRun, holderOf, runState, replyOf, runThread, taskThread, jobThread, watchThread, goalThread, threadIdOf, agentThread, agentsIn };
}

export const get = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<BoardView> => {
    assertDashboardKey(args.key);
    const now = Date.now();
    const load = loader(ctx, now);
    const threads: BoardThread[] = [];
    const events: BoardEvent[] = [];
    const runners = await load.allRunners();
    const machineOf = async (run: Doc<"runs">) => {
      const turn = await load.turnOf(run._id);
      return turn?.runnerId ? runners.get(turn.runnerId)?.name : undefined;
    };

    // Background tasks: every one going, then the latest that are over.
    const active = (await Promise.all((["blocked", "running", "queued"] as const).map((status) =>
      ctx.db.query("tasks").withIndex("by_status", (q) => q.eq("status", status)).collect()))).flat();
    const seen = new Set(active.map((task) => task._id));
    const ended = (await ctx.db.query("tasks").withIndex("by_updated").order("desc").take(ENDED_TASKS + active.length))
      .filter((task) => !seen.has(task._id)).slice(0, ENDED_TASKS);
    // The line queued tasks wait in, oldest first, as tasks.tick starts them; one waiting for a reset is out of it.
    const line = active.filter((task) => task.status === "queued" && !(task.waiting && task.waiting.until > now))
      .sort((a, b) => a.createdAt - b.createdAt).map((task) => task._id);
    for (const task of [...active, ...ended]) {
      const thread = await load.taskThread(task);
      if (line.includes(task._id)) thread.inLine = line.indexOf(task._id) + 1;
      threads.push(thread);
      events.push({ id: `${thread.id}:queued`, thread: thread.id, at: task.createdAt, verb: "queued", status: "queued", text: task.title });
      if (task.status === "blocked" && task.question) events.push({ id: `${thread.id}:asked:${task.updatedAt}`, thread: thread.id, at: task.updatedAt, verb: "asked", status: "waiting", text: task.question });
      if (task.status === "done") events.push({ id: `${thread.id}:done`, thread: thread.id, at: task.updatedAt, verb: "finished", status: "done", text: firstLine(task.result) ?? task.title });
      if (task.status === "failed") events.push({ id: `${thread.id}:failed`, thread: thread.id, at: task.updatedAt, verb: "failed", status: "failed", text: firstLine(task.error) ?? task.title });
      if (task.status === "cancelled") events.push({ id: `${thread.id}:stopped`, thread: thread.id, at: task.updatedAt, verb: "stopped", status: "done", text: task.title });
    }

    for (const job of await ctx.db.query("jobs").collect()) threads.push(await load.jobThread(job));
    for (const goal of await ctx.db.query("goals").collect()) threads.push(load.goalThread(goal));
    for (const monitor of await ctx.db.query("monitors").collect()) {
      const thread = load.watchThread(monitor);
      threads.push(thread);
      if (monitor.firedAt) events.push({ id: `${thread.id}:fired:${monitor.firedAt}`, thread: thread.id, at: monitor.firedAt, verb: "fired", text: firedOn(monitor) ? firstLine(monitor.lastObservation) : undefined });
    }

    // Turns: a chat's own are threads of their own; a task's or a schedule's go on its thread. The latest, and
    // whatever is still going however long ago it began: each computer's queued and running turns, and the turn of
    // a chat waiting on an approval.
    const runs = await ctx.db.query("runs").withIndex("by_started").order("desc").take(RUNS);
    const have = new Set(runs.map((run) => run._id));
    const keep = (run: Doc<"runs"> | null) => { if (run && !have.has(run._id)) { have.add(run._id); runs.push(run); } };
    for (const runnerId of runners.keys()) {
      for (const status of ["running", "queued"] as const) {
        for (const turn of await ctx.db.query("codexTurns").withIndex("by_runner_status", (q) => q.eq("runnerId", runnerId).eq("status", status)).take(50)) keep(await ctx.db.get(turn.runId));
      }
    }
    for (const approval of await load.pending()) keep(await load.latestRun(approval.conversationId));
    for (const run of runs) {
      const conversation = await load.chat(run.conversationId);
      const own = !conversation?.taskId && !conversation?.jobId;
      const thread = own ? await load.runThread(run) : null;
      if (thread) threads.push(thread);
      const id = thread?.id ?? await load.threadIdOf(run.conversationId, run._id);
      const machine = await machineOf(run);
      events.push({ id: `run:${run._id}:started`, thread: id, at: run.startedAt, verb: "started", text: own ? firstLine(run.prompt, 120) : undefined, ...(machine ? { machine } : {}) });
      if (run.status === "running") {
        const said = await ctx.db.query("runSpans").withIndex("by_run_started", (q) => q.eq("runId", run._id)).order("desc")
          .filter((q) => q.eq(q.field("kind"), "commentary")).first();
        const text = firstLine(said?.output ? citedMemories(said.output).text : undefined);
        if (said && text) events.push({ id: `span:${said._id}`, thread: id, at: said.startedAt, verb: "posted", status: "working", text, ...(machine ? { machine } : {}) });
      } else if (run.finishedAt !== undefined && !conversation?.taskId) {
        // A task says how it ended once, from the task; each turn of a chat or run of a schedule says it here.
        const state = await load.runState(run);
        const verb: BoardVerb = state.label === "Stopped" ? "stopped" : state.status === "failed" ? "failed" : "finished";
        events.push({ id: `run:${run._id}:${verb}`, thread: id, at: run.finishedAt, verb, status: verb === "failed" ? "failed" : "done", text: verb === "failed" ? firstLine(run.error) : verb === "finished" && own ? await load.replyOf(run) : undefined, ...(machine ? { machine } : {}) });
      }
    }

    const waiting: BoardWaiting[] = [];
    for (const task of active) {
      if (task.status === "blocked" && task.question) waiting.push({ id: `question:${task._id}`, kind: "question", text: task.question, where: task.title, thread: `task:${task._id}`, href: boardLink({ channel: "tasks", thread: `task:${task._id}` }), at: task.updatedAt });
    }
    for (const approval of await load.pending()) {
      const thread = await load.threadIdOf(approval.conversationId);
      const chat = await load.chat(approval.conversationId);
      waiting.push({
        id: `approval:${approval._id}`, kind: "approval", text: approval.title, ...(chat?.title ? { where: chat.title } : {}), ...(thread ? { thread } : {}),
        href: boardLink({ thread: thread ?? `approval:${approval._id}` }), at: approval.createdAt, ...(approval.kind === "command" ? { command: true } : {}),
      });
      events.push({ id: `approval:${approval._id}`, ...(thread ? { thread } : {}), at: approval.createdAt, verb: "approval", status: "waiting", text: approval.title, href: boardLink({ thread: thread ?? `approval:${approval._id}` }) });
    }

    // Sub-agents, under the thread whose turn started them; their starts and ends are told on that thread.
    const parents = new Set(threads.map((thread) => thread.id));
    const chats = new Set(threads.flatMap((thread) => thread.chatId ? [thread.chatId] : []));
    for (const chatId of chats) {
      for (const { conversation, parent } of await load.agentsIn(chatId)) {
        if (!parent || !parents.has(parent)) continue;
        const agent = await load.agentThread(conversation, parent);
        threads.push(agent);
        const tag = { id: agent.id, title: agent.title };
        const machine = agent.holder?.machine;
        events.push({ id: `${agent.id}:started`, thread: parent, at: agent.startedAt, verb: "started", status: "working", agent: tag, ...(machine ? { machine } : {}) });
        if (agent.finishedAt !== undefined) {
          const verb: BoardVerb = agent.status === "failed" ? "failed" : agent.label === "Stopped" ? "stopped" : "finished";
          events.push({ id: `${agent.id}:${verb}`, thread: parent, at: agent.finishedAt, verb, status: agent.status, agent: tag, ...(agent.now ? { text: agent.now } : {}), ...(machine ? { machine } : {}) });
        }
      }
    }

    const rank: Record<BoardStatus, number> = { waiting: 0, working: 1, blocked: 2, queued: 3, failed: 4, done: 4 };
    // An event of a thread no longer on the board (an older task's turn) is left off the rail; an approval from a
    // chat whose turn is not on it stays, and opens where it is answered.
    const listed = new Set(threads.map((thread) => thread.id));
    const placed = events.flatMap((event) => !event.thread || listed.has(event.thread) ? [event]
      : event.verb === "approval" ? [(({ thread: _thread, ...rest }) => rest)(event)] : []);
    return {
      threads: threads.sort((a, b) => rank[a.status] - rank[b.status] || b.updatedAt - a.updatedAt),
      // Each thread's latest event, before the cut: a busy schedule's many runs never crowd the others out.
      events: latestEach(placed).slice(0, EVENTS),
      waiting: waiting.map((item) => item.thread && !listed.has(item.thread) ? (({ thread: _thread, ...rest }) => rest)(item) : item).sort((a, b) => b.at - a.at),
      projects: (await ctx.db.query("projects").collect()).map((project) => ({ id: project._id, name: project.name })).sort((a, b) => a.name.localeCompare(b.name)),
      machines: [...runners.values()].filter((runner) => !runner.revoked).map((runner) => ({ name: runner.name, online: now - (runner.lastSeenAt ?? 0) < ONLINE_MS })),
    };
  },
});

/** One thread, with the feed of what it did: its turns and their steps, what it said, asked and ended with. */
export const thread = query({
  args: { key: v.string(), id: v.string() },
  handler: async (ctx, args): Promise<ThreadView | null> => {
    assertDashboardKey(args.key);
    const now = Date.now();
    const load = loader(ctx, now);
    const [kind, raw] = [args.id.slice(0, args.id.indexOf(":")), args.id.slice(args.id.indexOf(":") + 1)];
    const feed: FeedItem[] = [];

    /** The last step a run took, in its words ("Ran bank-cli export"), for a failure to say where it stopped. */
    const lastStep = async (run: Doc<"runs"> | null | undefined) => {
      if (!run) return {};
      for await (const span of ctx.db.query("runSpans").withIndex("by_run_started", (q) => q.eq("runId", run._id)).order("desc")) {
        if (span.kind !== "reasoning" && span.kind !== "plan" && span.kind !== "commentary") return { step: describeStep(span, { done: true }).label };
      }
      return {};
    };
    const runFeed = async (run: Doc<"runs">, withEnd: boolean) => {
      const state = await load.runState(run);
      feed.push({ kind: "run", id: `run:${run._id}`, runId: run._id, at: run.startedAt, holder: await load.holderOf(run), ...state, ...(run.finishedAt !== undefined ? { endedAt: run.finishedAt } : {}) });
      // A turn's reply is the last of its timeline; only a failure needs saying after it.
      if (withEnd && run.finishedAt !== undefined && run.status === "error" && run.error !== STOPPED) {
        feed.push({ kind: "error", id: `run:${run._id}:error`, at: run.finishedAt, text: run.error ?? "It stopped without saying why.", ...await lastStep(run) });
      }
    };
    const approvalsIn = async (conversationId: Id<"conversations"> | undefined) => {
      if (!conversationId) return;
      for (const row of (await load.pending()).filter((item) => item.conversationId === conversationId)) {
        feed.push({ kind: "approval", id: `approval:${row._id}`, at: row.createdAt, text: row.title, href: `/chat/${conversationId}` });
      }
    };
    const runsOf = async (conversationId: Id<"conversations"> | undefined, count: number) => conversationId
      ? (await ctx.db.query("runs").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).order("desc").take(count)).reverse()
      : [];
    /** The sub-agents a thread's turns started, for its pane to list. */
    const agentsOf = async (thread: BoardThread) => thread.chatId
      ? (await Promise.all((await load.agentsIn(thread.chatId)).filter((item) => item.parent === thread.id).map((item) => load.agentThread(item.conversation, thread.id))))
        .sort((a, b) => a.startedAt - b.startedAt)
      : [];
    const withAgents = async (view: ThreadView): Promise<ThreadView> => {
      const agents = await agentsOf(view.thread);
      return agents.length ? { ...view, agents } : view;
    };
    const sorted = (thread: BoardThread, plan?: Doc<"tasks">["plan"]): ThreadView => ({
      thread,
      ...(plan?.length ? { plan } : {}),
      // Oldest first, as a thread reads: a turn's line before its steps, what it ended with after them.
      feed: feed.sort((a, b) => a.at - b.at || PLACE[a.kind] - PLACE[b.kind]),
    });

    if (kind === "task") {
      const id = ctx.db.normalizeId("tasks", raw);
      const task = id ? await ctx.db.get(id) : null;
      if (!task) return null;
      const runs = await runsOf(task.conversationId, TASK_RUNS);
      for (const run of runs) await runFeed(run, false);
      for (const said of task.steering ?? []) feed.push({ kind: "said", id: `said:${said.requestId}`, at: said.createdAt, text: said.text });
      await approvalsIn(task.conversationId);
      if (task.status === "blocked" && task.question) feed.push({ kind: "question", id: `${args.id}:question`, at: task.updatedAt, text: task.question, href: boardLink({ channel: "tasks", thread: `task:${task._id}` }) });
      if (task.status === "done" && task.result) feed.push({ kind: "result", id: `${args.id}:result`, at: task.updatedAt, text: task.result });
      if (task.status === "failed") feed.push({ kind: "error", id: `${args.id}:error`, at: task.updatedAt, text: task.error ?? "It stopped without saying why.", ...await lastStep(runs.at(-1)) });
      return withAgents(sorted(await load.taskThread(task), task.plan));
    }
    if (kind === "job") {
      const id = ctx.db.normalizeId("jobs", raw);
      const job = id ? await ctx.db.get(id) : null;
      if (!job) return null;
      const runs = await runsOf(job.conversationId, JOB_RUNS);
      for (const run of runs) await runFeed(run, run !== runs.at(-1));
      await approvalsIn(job.conversationId);
      const last = runs.at(-1);
      const endedAt = last?.finishedAt ?? job.lastRunAt;
      if (last?.status !== "running" && endedAt !== undefined) {
        if (job.lastError) feed.push({ kind: "error", id: `${args.id}:error`, at: endedAt, text: job.lastError, ...await lastStep(last) });
        else if (job.lastResult) {
          feed.push({ kind: "result", id: `${args.id}:result`, at: endedAt, text: job.lastResult.trim() === QUIET ? "Nothing new." : job.lastResult });
          const item = feed.find((entry) => entry.kind === "run" && entry.runId === last?._id);
          if (item?.kind === "run") item.omit = job.lastResult;
        }
      }
      return withAgents(sorted(await load.jobThread(job)));
    }
    if (kind === "run") {
      const id = ctx.db.normalizeId("runs", raw);
      const run = id ? await ctx.db.get(id) : null;
      if (!run) return null;
      await runFeed(run, true);
      if (run.status === "running") await approvalsIn(run.conversationId);
      // A chat turn ends in its reply, which the turn keeps whether or not one of its steps carried it.
      const reply = run.status === "ok" ? (await load.turnOf(run._id))?.response?.trim() : undefined;
      if (reply && run.finishedAt !== undefined) {
        feed.push({ kind: "result", id: `run:${run._id}:reply`, at: run.finishedAt, text: reply, reply: true });
        const item = feed.find((entry) => entry.kind === "run");
        if (item?.kind === "run") item.omit = reply;
      }
      return withAgents(sorted(await load.runThread(run)));
    }
    if (kind === "watch") {
      const id = ctx.db.normalizeId("monitors", raw);
      const monitor = id ? await ctx.db.get(id) : null;
      if (!monitor) return null;
      if (monitor.firedAt) feed.push({ kind: "result", id: `${args.id}:fired`, at: monitor.firedAt, text: firedOn(monitor) && monitor.lastObservation ? monitor.lastObservation : "Its condition was met." });
      if (monitor.lastCheckedAt && monitor.lastObservation && !firedOn(monitor)) feed.push({ kind: "update", id: `${args.id}:checked`, at: monitor.lastCheckedAt, text: monitor.lastObservation });
      if (monitor.failures > 0 && monitor.lastCheckedAt) feed.push({ kind: "error", id: `${args.id}:failing`, at: monitor.lastCheckedAt, text: monitor.failures === 1 ? "The last check failed." : `The last ${monitor.failures} checks failed.` });
      return sorted(load.watchThread(monitor));
    }
    if (kind === "agent") {
      const id = ctx.db.normalizeId("conversations", raw);
      const conversation = id ? await ctx.db.get(id) : null;
      if (!conversation?.providerAgent || !conversation.parentConversationId) return null;
      const parentId = await load.threadIdOf(conversation.parentConversationId, conversation.providerAgent.runId);
      if (!parentId) return null;
      const agent = await load.agentThread(conversation, parentId);
      const [parentKind, parentRaw] = [parentId.slice(0, parentId.indexOf(":")), parentId.slice(parentId.indexOf(":") + 1)];
      const parentDoc = parentKind === "task" ? await ctx.db.get(parentRaw as Id<"tasks">) : parentKind === "job" ? await ctx.db.get(parentRaw as Id<"jobs">) : await ctx.db.get(parentRaw as Id<"runs">);
      const parentThread = !parentDoc ? undefined : parentKind === "task" ? await load.taskThread(parentDoc as Doc<"tasks">)
        : parentKind === "job" ? await load.jobThread(parentDoc as Doc<"jobs">) : await load.runThread(parentDoc as Doc<"runs">);
      const text = conversation.providerAgent.text?.trim();
      if (agent.status === "failed") feed.push({ kind: "error", id: `${args.id}:error`, at: agent.finishedAt ?? agent.updatedAt, text: text ? firstLine(text.split("\n").filter(Boolean).at(-1)) ?? text : "It stopped without saying why." });
      return {
        ...sorted(agent),
        parent: { id: parentId, title: parentThread?.title ?? "its turn", ...(parentThread?.holder ? { holder: parentThread.holder } : {}) },
        ...(text ? { output: text } : {}),
      };
    }
    if (kind === "goal") {
      const id = ctx.db.normalizeId("goals", raw);
      const goal = id ? await ctx.db.get(id) : null;
      if (!goal) return null;
      return sorted(load.goalThread(goal), goal.milestones.map((milestone) => ({ title: milestone.title, status: milestone.done ? "done" as const : "pending" as const })));
    }
    return null;
  },
});
