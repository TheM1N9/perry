import { v, type Infer } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { assertDashboardKey } from "./lib/auth";
import { DEFAULT_ENGINE, ENGINE_LABELS, ENGINES, engineOf, type EngineKind, type LoginInteraction } from "./lib/engines";
import { authenticate } from "./runner";
import { vEngine, vEngineStatus, vLoginInteraction } from "./schema";

/**
 * The engines on each connected computer, as the runner reports them, and
 * signing them in and out from Settings. A chat's turns go to a runner whose
 * engine for that chat is installed and signed in (codex.ts, pickRunner).
 *
 * Only account metadata and what the owner must do to sign in (a code, a page,
 * a command) cross this server. An engine's tokens never leave its own CLI.
 */

export type EngineStatus = Infer<typeof vEngineStatus>;
type Reported = EngineStatus & { updatedAt: number };

/** How long a runner may go unseen and still count as online. */
const ONLINE_MS = 90_000;
export const isOnline = (runner: Doc<"runners">) => !runner.revoked && (runner.lastSeenAt ?? 0) > Date.now() - ONLINE_MS;

/**
 * A runner's engines. One from before engines reported only Codex, in its
 * codex* fields, and is read from those.
 */
export function statusesOf(runner: Doc<"runners">): Reported[] {
  if (runner.engines) return runner.engines;
  if (runner.codexAvailable === undefined) return [];
  return [{
    kind: "codex",
    installed: runner.codexAvailable,
    signedIn: runner.codexAuthMode === "chatgpt",
    auth: { type: runner.codexAuthMode, label: runner.codexAuthMode === "chatgpt" ? "ChatGPT" : runner.codexAuthMode, plan: runner.codexPlanType },
    models: runner.codexModels ?? [],
    error: runner.codexError,
    updatedAt: runner.codexUpdatedAt ?? 0,
  }];
}

/** The runner can run this engine's turns now: installed and signed in. */
export const engineReady = (runner: Doc<"runners">, engine: EngineKind) =>
  statusesOf(runner).some((status) => status.kind === engine && status.installed && status.signedIn);

/**
 * Keep what the runner found. A model list that came back empty while signed
 * in (a listing that failed for a moment) keeps the one from before.
 */
export async function recordEngines(ctx: MutationCtx, runner: Doc<"runners">, reported: EngineStatus[]) {
  const before = statusesOf(runner);
  const now = Date.now();
  const engines = reported.map((status): Reported => ({
    ...status,
    message: status.message?.slice(0, 500),
    error: status.error?.slice(0, 500),
    models: status.models.length ? status.models : before.find((item) => item.kind === status.kind)?.models ?? [],
    updatedAt: now,
  }));
  const codex = engines.find((status) => status.kind === "codex");
  await ctx.db.patch(runner._id, {
    engines,
    // Runners, scripts and checks from before engines read Codex's state here.
    ...(codex ? {
      codexAvailable: codex.installed,
      codexAuthMode: codex.auth.type,
      codexPlanType: codex.auth.plan,
      codexError: codex.error,
      codexModels: codex.models.length ? codex.models : runner.codexModels,
      codexUpdatedAt: now,
    } : {}),
  });
}

// --- The default engine -------------------------------------------------------

/** Engines signed in on an online computer, and on any computer at all (one offline now included). */
export async function signedInEngines(ctx: Pick<QueryCtx, "db">): Promise<{ online: Set<EngineKind>; anywhere: Set<EngineKind> }> {
  const runners = (await ctx.db.query("runners").order("desc").take(20)).filter((runner) => !runner.revoked);
  const online = new Set<EngineKind>();
  const anywhere = new Set<EngineKind>();
  for (const runner of runners) {
    for (const status of statusesOf(runner)) {
      if (!status.installed || !status.signedIn) continue;
      anywhere.add(status.kind);
      if (isOnline(runner)) online.add(status.kind);
    }
  }
  return { online, anywhere };
}

/**
 * The engine new chats, and jobs without a model, run on: the owner's pick
 * (Settings, Engines) while it is signed in on an online computer; else the
 * first that is, in ENGINES' order (Codex, Claude Code, Grok, Cursor,
 * Antigravity); else one signed in on a computer that is offline now. With
 * none signed in anywhere, the pick, or Codex. A chat keeps the engine it
 * started on: changing the default, or an engine signing out, never moves it.
 */
export async function defaultEngine(ctx: Pick<QueryCtx, "db">): Promise<EngineKind> {
  const picked = (await ctx.db.query("installation").first())?.defaultEngine;
  const { online, anywhere } = await signedInEngines(ctx);
  const order = picked ? [picked, ...ENGINES] : ENGINES;
  return order.find((engine) => online.has(engine)) ?? order.find((engine) => anywhere.has(engine)) ?? picked ?? DEFAULT_ENGINE;
}

/** Settings' default engine: the pick, the engine it comes to, and those signed in to pick from. */
export const getDefault = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<{ picked?: EngineKind; engine: EngineKind; choices: Array<{ kind: EngineKind; label: string; online: boolean }> }> => {
    assertDashboardKey(args.key);
    const { online, anywhere } = await signedInEngines(ctx);
    return {
      picked: (await ctx.db.query("installation").first())?.defaultEngine,
      engine: await defaultEngine(ctx),
      choices: ENGINES.filter((engine) => anywhere.has(engine)).map((kind) => ({ kind, label: ENGINE_LABELS[kind], online: online.has(kind) })),
    };
  },
});

/** Pick the default engine, from those signed in on some computer. Chats already started keep theirs. */
export const setDefault = mutation({
  args: { key: v.string(), engine: vEngine },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const install = await ctx.db.query("installation").first();
    if (!install) throw new Error("Run pnpm run setup first.");
    if (!(await signedInEngines(ctx)).anywhere.has(args.engine)) {
      throw new Error(`${ENGINE_LABELS[args.engine]} isn't signed in on any computer. Sign in to it first.`);
    }
    await ctx.db.patch(install._id, { defaultEngine: args.engine });
    return null;
  },
});

// --- A chat's engine session ------------------------------------------------

export type Resume = { engine: EngineKind; cursor: string; version: number };

/** Where the chat's engine session resumes. A chat from before engines has its Codex thread instead. */
export function resumeOf(chat: Doc<"conversations">): Resume | undefined {
  const engine = engineOf(chat);
  if (chat.resume?.engine === engine) return chat.resume;
  if (engine === "codex" && chat.codexThreadId) return { engine, cursor: chat.codexThreadId, version: 1 };
  return undefined;
}

/** Fields that end a chat's engine session: its next turn starts a new one, seeded with the chat so far. */
export const FORGET_SESSION = { resume: undefined, codexThreadId: undefined } as const;

/**
 * The change to a chat for a model picked for it. Another engine's model
 * moves the chat to that engine, which starts afresh with the chat's history,
 * and hears the recalled memory again.
 */
export function pickPatch(chat: Doc<"conversations">, model: string | undefined, engine?: EngineKind) {
  const switching = engine !== undefined && engine !== engineOf(chat);
  return {
    model: model?.trim() || undefined,
    ...(switching ? { engine, ...FORGET_SESSION, recallDigest: undefined } : {}),
  };
}

// --- Runner side ------------------------------------------------------------

/** Each engine's status, from the runner's probes every half minute and after a sign-in. */
export const report = mutation({
  args: { token: v.string(), engines: v.array(vEngineStatus) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    await recordEngines(ctx, runner, args.engines);
    return null;
  },
});

/** Sign-ins and sign-outs the owner asked of this runner, waiting for it. */
export const queuedAuth = query({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<Array<{ engine: EngineKind; id: number; kind: "login" | "logout" }>> => {
    const runner = await authenticate(ctx, args.token);
    return Object.entries(runner.engineAuth ?? {})
      .filter(([, request]) => request.status === "queued")
      .map(([engine, request]) => ({ engine: engine as EngineKind, id: request.id, kind: request.kind }));
  },
});

/** A runner that restarted mid sign-in cannot finish it: those are failed, to be started again. */
export const recoverAuth = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const requests = runner.engineAuth ?? {};
    if (!Object.values(requests).some((request) => request.status === "running")) return null;
    await ctx.db.patch(runner._id, {
      engineAuth: Object.fromEntries(Object.entries(requests).map(([engine, request]) => [engine, request.status === "running"
        ? { id: request.id, kind: request.kind, status: "error" as const, error: "Runner restarted. Start sign-in again." }
        : request])),
    });
    return null;
  },
});

export const claimAuth = mutation({
  args: { token: v.string(), engine: vEngine, id: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const request = runner.engineAuth?.[args.engine];
    if (request?.status !== "queued" || request.id !== args.id) return false;
    await ctx.db.patch(runner._id, { engineAuth: { ...runner.engineAuth, [args.engine]: { ...request, status: "running" } } });
    return true;
  },
});

/** How the sign-in is going: what the owner must do while it runs, then done or failed. */
export const updateAuth = mutation({
  args: {
    token: v.string(),
    engine: vEngine,
    id: v.number(),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("error")),
    interaction: v.optional(vLoginInteraction),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const request = runner.engineAuth?.[args.engine];
    if (!request || request.id !== args.id || request.status !== "running") return null;
    await ctx.db.patch(runner._id, {
      engineAuth: {
        ...runner.engineAuth,
        [args.engine]: {
          id: request.id,
          kind: request.kind,
          status: args.status,
          ...(args.status === "running" && args.interaction ? { interaction: args.interaction } : {}),
          ...(args.error ? { error: args.error.slice(0, 500) } : {}),
        },
      },
    });
    return null;
  },
});

// --- Dashboard side ---------------------------------------------------------

export type EngineView = {
  kind: EngineKind;
  label: string;
  installed: boolean;
  version?: string;
  signedIn: boolean;
  auth: EngineStatus["auth"];
  message?: string;
  error?: string;
  updatedAt: number;
  request?: { kind: "login" | "logout"; status: "queued" | "running" | "done" | "error"; interaction?: LoginInteraction; error?: string };
};

/** Every connected computer and its engines, for Settings. */
export const list = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<Array<{ id: Doc<"runners">["_id"]; name: string; online: boolean; engines: EngineView[] }>> => {
    assertDashboardKey(args.key);
    const runners = await ctx.db.query("runners").order("desc").take(20);
    return runners.filter((runner) => !runner.revoked).map((runner) => ({
      id: runner._id,
      name: runner.name,
      online: isOnline(runner),
      engines: statusesOf(runner).map((status) => {
        const request = runner.engineAuth?.[status.kind];
        return {
          kind: status.kind,
          label: ENGINE_LABELS[status.kind],
          installed: status.installed,
          version: status.version,
          signedIn: status.signedIn,
          auth: status.auth,
          message: status.message,
          error: status.error,
          updatedAt: status.updatedAt,
          ...(request ? { request: { kind: request.kind, status: request.status, interaction: request.interaction, error: request.error } } : {}),
        };
      }),
    }));
  },
});

/** Sign an engine in or out on a computer. Its runner picks this up and says what to do next. */
export const requestAuth = mutation({
  args: { key: v.string(), runnerId: v.id("runners"), engine: vEngine, kind: v.union(v.literal("login"), v.literal("logout")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const runner = await ctx.db.get(args.runnerId);
    const label = ENGINE_LABELS[args.engine];
    if (!runner || !isOnline(runner)) throw new Error(`Start Perry on this computer before connecting ${label}.`);
    const status = statusesOf(runner).find((item) => item.kind === args.engine);
    if (!status?.installed) throw new Error(status?.error || status?.message || `${label} isn't installed on this computer.`);
    const current = runner.engineAuth?.[args.engine];
    if (current?.status === "queued" || current?.status === "running") throw new Error(`A ${label} sign-in is already in progress.`);
    await ctx.db.patch(runner._id, {
      engineAuth: { ...runner.engineAuth, [args.engine]: { id: (current?.id ?? 0) + 1, kind: args.kind, status: "queued" } },
    });
    return null;
  },
});
