import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { ENGINE_LABELS, ENGINES, engineOf, type EngineKind } from "./lib/engines";
import { BACKGROUND_CAP, ROUTING_RULE, effortFor, isTier, modelFor, roomOf, route, type Choice, type OwnerPick, type PerryPick, type Work } from "./lib/routing";
import { modelsOf, parseModelKey } from "./lib/commands";
import { LIMIT_HIT } from "./lib/usage";
import { historyOf } from "./lib/agent";
import { sendMessage } from "./lib/telegram";
import { FORGET_SESSION, engineUsable, isOnline, resumeOf } from "./engines";
import { engineModels } from "./models";
import { authenticate } from "./runner";
import { liveRunners, usageByEngine } from "./usage";
import { vEngine, vPerryPick, vRoute } from "./schema";

/**
 * Where each piece of work runs (issue #189): the rule is in lib/routing.ts,
 * and this reads what it needs (each engine's models, which are signed in on a
 * computer that is online, and how much of each plan is left), and does what
 * follows from it: a turn its engine refused part-way for a limit tried once on
 * another (retryTurn), and what a limit stopped started again (jobs.ts and
 * tasks.ts call recover*, and the sweep finds the rest).
 */

export type Route = Infer<typeof vRoute>;

export const vWork = v.union(
  v.object({ kind: v.literal("chat") }),
  v.object({ kind: v.literal("job"), builtin: v.optional(v.union(v.literal("heartbeat"), v.literal("daily-summary"), v.literal("consolidate"))), once: v.optional(v.boolean()), event: v.optional(v.boolean()) }),
  v.object({ kind: v.literal("task"), brief: v.number() }),
);
const vOwnerPick = v.object({ engine: v.optional(vEngine), model: v.optional(v.string()), effort: v.optional(v.string()), stay: v.optional(v.boolean()) });

type Ask = {
  work: Work;
  owner?: OwnerPick;
  perry?: PerryPick;
  current?: EngineKind;
  attended?: boolean;
  avoid?: EngineKind[];
  /** The chat's computer, whose engines it can use. */
  runnerId?: Id<"runners">;
};

/** Pick for a piece of work, from what the server knows now. */
export async function choose(ctx: QueryCtx, ask: Ask): Promise<Choice> {
  const runners = await liveRunners(ctx);
  const pinned = ask.runnerId ? runners.find((runner) => runner._id === ask.runnerId) : undefined;
  // A chat stays on its computer (codex.pickRunner): only the engines there will take it.
  const here = runners.filter((runner) => isOnline(runner) && (!pinned || (runner.hostname === pinned.hostname && runner.platform === pinned.platform)));
  const engines = ENGINES.filter((engine) => here.some((runner) => engineUsable(runner, engine)));
  const timeZone = (await ctx.db.query("installation").first())?.timezone;
  return route({ ...ask, engines, models: await engineModels(ctx), usage: usageByEngine(runners), now: Date.now(), ...(timeZone ? { timeZone } : {}) });
}

/** What a run records of a choice: all but the wait. */
export const routeOf = (choice: Choice): Route => ({
  engine: choice.engine, tier: choice.tier, by: choice.by, why: choice.why.slice(0, 1000),
  ...(choice.model ? { model: choice.model } : {}), ...(choice.effort ? { effort: choice.effort } : {}),
  ...(choice.movedFrom ? { movedFrom: { ...choice.movedFrom, why: choice.movedFrom.why.slice(0, 500) } } : {}),
});

/** The engine a job's or task's chat is on, once it has one. */
async function chatEngine(ctx: QueryCtx, id?: Id<"conversations">): Promise<EngineKind | undefined> {
  const chat = id ? await ctx.db.get(id) : null;
  return chat ? engineOf(chat) : undefined;
}

/** A job's ask: the owner's model (Work page) and keep-it-there, Perry's pick, and its chat's engine. */
export async function jobAsk(ctx: QueryCtx, job: Doc<"jobs">, avoid?: EngineKind[]): Promise<Ask> {
  const owner: OwnerPick | undefined = job.model || job.stay ? { engine: engineOf(job), ...(job.model ? { model: job.model } : {}), ...(job.stay ? { stay: true } : {}) } : undefined;
  return {
    work: { kind: "job", ...(job.builtin ? { builtin: job.builtin } : {}), once: job.runAt !== undefined, event: Boolean(job.trigger) },
    ...(owner ? { owner } : {}),
    ...(job.pick ? { perry: job.pick } : {}),
    current: await chatEngine(ctx, job.conversationId),
    ...(avoid?.length ? { avoid } : {}),
  };
}

export async function taskAsk(ctx: QueryCtx, task: Doc<"tasks">, avoid?: EngineKind[]): Promise<Ask> {
  return {
    work: { kind: "task", brief: task.prompt.length },
    ...(task.pick ? { perry: task.pick } : {}),
    current: await chatEngine(ctx, task.conversationId),
    ...(avoid?.length ? { avoid } : {}),
  };
}

/**
 * An owner's chat: its engine and model, kept while its engine has room. A
 * chat that has never run picks an engine; one from before engines that has a
 * Codex session is on Codex.
 */
export function chatAsk(chat: Doc<"conversations">): Ask {
  const engine = chat.engine ?? (resumeOf(chat) ? "codex" : undefined);
  return {
    work: { kind: "chat" },
    owner: { ...(engine ? { engine } : {}), ...(chat.model && engine ? { model: chat.model } : {}), ...(chat.effort ? { effort: chat.effort } : {}) },
    ...(engine ? { current: engine } : {}),
    attended: true,
    ...(chat.codexRunnerId ? { runnerId: chat.codexRunnerId } : {}),
  };
}

export const forJob = internalQuery({
  args: { id: v.id("jobs"), avoid: v.optional(v.array(vEngine)) },
  handler: async (ctx, args): Promise<Choice | null> => {
    const job = await ctx.db.get(args.id);
    return job ? await choose(ctx, await jobAsk(ctx, job, args.avoid)) : null;
  },
});

export const forTask = internalQuery({
  args: { id: v.id("tasks"), avoid: v.optional(v.array(vEngine)) },
  handler: async (ctx, args): Promise<Choice | null> => {
    const task = await ctx.db.get(args.id);
    return task ? await choose(ctx, await taskAsk(ctx, task, args.avoid)) : null;
  },
});

export const forChat = internalQuery({
  args: { id: v.id("conversations") },
  handler: async (ctx, args): Promise<Choice | null> => {
    const chat = await ctx.db.get(args.id);
    return chat ? await choose(ctx, chatAsk(chat)) : null;
  },
});

/** For the agent's own picks: which engines it can name, as list_engines shows them. */
export const pickFor = internalQuery({
  args: { work: vWork, perry: v.optional(vPerryPick), owner: v.optional(vOwnerPick) },
  handler: async (ctx, args): Promise<Choice> => await choose(ctx, { work: args.work, ...(args.perry ? { perry: args.perry } : {}), ...(args.owner ? { owner: args.owner } : {}) }),
});

/**
 * Move a chat to another engine, as routing chose: it starts a session there
 * with the chat so far. An owner's chat says why above its composer.
 */
export async function moveChat(ctx: MutationCtx, chat: Doc<"conversations">, choice: { engine: EngineKind; model?: string }, moved?: { from: EngineKind; why: string }) {
  // Already there (a chat from before engines is on Codex): only said so.
  if (engineOf(chat) === choice.engine) {
    if (!chat.engine) await ctx.db.patch(chat._id, { engine: choice.engine });
    return;
  }
  const owners = !chat.jobId && !chat.taskId;
  await ctx.db.patch(chat._id, {
    engine: choice.engine,
    // An owner's chat keeps no model of the engine it left; a job's or task's is routed each run.
    model: owners ? undefined : choice.model,
    ...FORGET_SESSION, recallDigest: undefined, projectDigest: undefined,
    ...(owners && moved ? { moved: { from: moved.from, why: moved.why.slice(0, 500), at: Date.now() } } : {}),
  });
}

export const moveChatTo = internalMutation({
  args: { id: v.id("conversations"), engine: vEngine, model: v.optional(v.string()), moved: v.optional(v.object({ from: vEngine, why: v.string() })) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.id);
    if (chat) await moveChat(ctx, chat, { engine: args.engine, ...(args.model ? { model: args.model } : {}) }, args.moved);
    return null;
  },
});

// --- A turn refused part-way ----------------------------------------------------------------------

/**
 * Whether a turn its engine refused for a limit can safely run again on
 * another: it did nothing yet (no step, no words, no file), nobody's words
 * joined it, it is not memory upkeep, a compaction or someone else's chat, and
 * it is not itself a retry.
 */
export async function retryable(ctx: QueryCtx, turn: Doc<"codexTurns">, outcome: { error?: string; response?: string; stopped?: boolean; media?: number }): Promise<boolean> {
  if (!outcome.error || !LIMIT_HIT.test(outcome.error) || outcome.stopped || outcome.response?.trim() || outcome.media || turn.mediaKey) return false;
  if (turn.retryOf || turn.kind || turn.flush || turn.checkpoint || turn.guest) return false;
  const run = await ctx.db.get(turn.runId);
  if (run?.toolCalls?.length) return false;
  const joined = await ctx.db.query("codexSteers").withIndex("by_turn_status", (q) => q.eq("turnId", turn._id).eq("status", "applied")).first();
  return !joined;
}

/** Where a refused turn would go now: null when nowhere else has room. */
export const retryPlan = internalQuery({
  args: { id: v.id("codexTurns") },
  handler: async (ctx, args): Promise<{ choice: Choice; conversation: Doc<"conversations"> } | null> => {
    const turn = await ctx.db.get(args.id);
    const conversation = turn ? await ctx.db.get(turn.conversationId) : null;
    if (!turn || !conversation || !turn.retrying || turn.finalizedAt) return null;
    const refused = engineOf(turn);
    const job = conversation.jobId ? await ctx.db.get(conversation.jobId) : null;
    const task = conversation.taskId ? await ctx.db.get(conversation.taskId) : null;
    const ask = job ? await jobAsk(ctx, job, [refused]) : task ? await taskAsk(ctx, task, [refused]) : { ...chatAsk(conversation), avoid: [refused] };
    // Kept on its engine by the owner, it is not moved for a refusal either.
    if (ask.owner?.stay) return null;
    const choice = await choose(ctx, ask);
    if (choice.wait || choice.engine === refused) return null;
    return { choice, conversation };
  },
});

/**
 * Its engine refused the turn for a limit before it did anything: run it once
 * more, on an engine with room, as part of the same run. With nowhere to go,
 * it fails as it would have, and what stopped it is picked up from there
 * (jobs.recoverJob, tasks.recoverTask).
 */
export const retryTurn = internalAction({
  args: { id: v.id("codexTurns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const plan = await ctx.runQuery(internal.routing.retryPlan, args);
    let moved = false;
    if (plan) {
      const history = await historyOf(ctx, plan.conversation).catch(() => undefined);
      moved = await ctx.runMutation(internal.codex.retryOn, { id: args.id, route: routeOf(plan.choice), ...(history ? { history } : {}) })
        .catch((error) => { console.error(`could not try the turn on another engine: ${String(error)}`); return false; });
      const chat = plan.conversation;
      if (moved && chat.channel !== "web" && !chat.jobId && !chat.taskId && !chat.contactId) {
        await tell(ctx, chat, `${plan.choice.movedFrom?.why ?? "This chat's engine has no room"}, so ${ENGINE_LABELS[plan.choice.engine]} answers this chat now.`).catch(() => {});
      }
    }
    if (!moved) {
      await ctx.runMutation(internal.routing.giveUpRetry, args);
      await ctx.scheduler.runAfter(0, internal.codex.finalizeTurn, args);
    }
    return null;
  },
});

/** A short note to an owner's chat in a messaging app. */
export async function tell(ctx: ActionCtx, chat: Doc<"conversations">, text: string) {
  if (chat.channel === "telegram") {
    const token: string | null = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
    await sendMessage(token, chat.externalId, text);
  } else if (chat.channel === "whatsapp") {
    await ctx.runMutation(internal.whatsapp.send, { to: chat.externalId, text });
  }
}

export const giveUpRetry = internalMutation({
  args: { id: v.id("codexTurns") },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (await ctx.db.get(args.id)) await ctx.db.patch(args.id, { retrying: undefined });
    return null;
  },
});

// --- For the runner ---------------------------------------------------------------------------------

/**
 * Which of its engines have room for quick side work (chat names, reviews),
 * by the background cap: the runner names chats and reviews actions on one
 * that has, when it can.
 */
export const rooms = query({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<Partial<Record<EngineKind, "room" | "low" | "out">>> => {
    await authenticate(ctx, args.token);
    const usage = usageByEngine(await liveRunners(ctx));
    const now = Date.now();
    return Object.fromEntries(ENGINES.map((engine) => [engine, roomOf(engine, usage[engine], now, BACKGROUND_CAP).state]));
  },
});

// --- For the agent ----------------------------------------------------------------------------------

/**
 * A pick the agent gave (create_job, update_job, queue_task), checked against
 * what the engines offer: a model as "<engine>/<id>", a thinking level that
 * model takes, a tier.
 */
export const checkPick = internalQuery({
  args: { tier: v.optional(v.string()), model: v.optional(v.string()), effort: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ pick?: PerryPick; error?: string }> => {
    const pick: PerryPick = {};
    if (args.tier) {
      if (!isTier(args.tier)) return { error: `There is no tier "${args.tier}": it is quick, standard or deep.` };
      pick.tier = args.tier;
    }
    const models = await engineModels(ctx);
    if (args.model) {
      const { engine, id } = parseModelKey(args.model.trim());
      const model = models.find((item) => (item.engine ?? "codex") === engine && item.id === id);
      if (!model) return { error: `No signed-in engine offers "${args.model}"; list_engines names the models as <engine>/<id>.` };
      Object.assign(pick, { engine, model: id });
      if (args.effort && model.efforts?.length && !model.efforts.includes(args.effort)) {
        return { error: `${model.name} has no thinking level "${args.effort}": it takes ${model.efforts.join(", ")}.` };
      }
    }
    if (args.effort) pick.effort = args.effort.trim().toLowerCase();
    return { pick };
  },
});

export type EngineRow = {
  engine: EngineKind;
  label: string;
  room: "room" | "low" | "out";
  why?: string;
  resetsAt?: string;
  /** What each tier runs there: "<model> at <level>". */
  tiers: Record<"quick" | "standard" | "deep", string>;
  models: Array<{ model: string; name: string; isDefault: boolean; efforts?: string[]; defaultEffort?: string }>;
};

/** What list_engines shows: each signed-in engine, how much room it has, its models and levels, and what each tier would run there. */
export const engines = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ engines: EngineRow[]; rule: string }> => {
    const runners = await liveRunners(ctx);
    const usage = usageByEngine(runners);
    const models = await engineModels(ctx);
    const now = Date.now();
    const signedIn = ENGINES.filter((engine) => runners.some((runner) => isOnline(runner) && engineUsable(runner, engine)));
    return {
      engines: signedIn.map((engine): EngineRow => {
        const room = roomOf(engine, usage[engine], now, BACKGROUND_CAP);
        const tiers = Object.fromEntries((["quick", "standard", "deep"] as const).map((tier) => {
          const model = modelFor(models, engine, tier);
          return [tier, [model?.id, effortFor(model, tier)].filter(Boolean).join(" at ")];
        })) as Record<"quick" | "standard" | "deep", string>;
        return {
          engine, label: ENGINE_LABELS[engine], room: room.state, tiers,
          ...(room.why ? { why: room.why } : {}),
          ...(room.until ? { resetsAt: new Date(room.until).toISOString() } : {}),
          models: modelsOf(models, engine).map((model) => ({
            model: `${engine}/${model.id}`, name: model.name, isDefault: model.isDefault,
            ...(model.efforts ? { efforts: model.efforts } : {}), ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
          })),
        };
      }),
      rule: ROUTING_RULE,
    };
  },
});
