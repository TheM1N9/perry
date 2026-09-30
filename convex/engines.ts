import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { assertDashboardKey } from "./lib/auth";
import { ENGINE_LABELS, engineOf, refusal, updateOf, type EngineKind, type EngineUpdate, type LoginInteraction } from "./lib/engines";
import { authenticate } from "./runner";
import { vEngine, vEngineStatus, vLoginInteraction } from "./schema";

/**
 * The engines on each connected computer, as the runner reports them, and
 * signing them in and out from Settings. A chat's turns go to a runner whose
 * engine for that chat is installed, signed in and not older than Perry works
 * with (codex.ts, pickRunner; the versions are in lib/engines.ts).
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

/** The engine's CLI on this runner is older than Perry works with, and how to update it: it is given no new turns. */
export function tooOld(runner: Doc<"runners">, engine: EngineKind): EngineUpdate | undefined {
  const status = statusesOf(runner).find((item) => item.kind === engine);
  const update = status && updateOf(status);
  return update?.need === "required" ? update : undefined;
}

/** Ready, and recent enough for Perry: a new turn may go to this runner's engine. */
export const engineUsable = (runner: Doc<"runners">, engine: EngineKind) => engineReady(runner, engine) && !tooOld(runner, engine);

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
    latest: status.latest?.slice(0, 50),
    update: status.update?.slice(0, 300),
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

/**
 * The key an engine needs from Settings → Keys, for this runner only: the
 * Gemini API key Antigravity takes. It goes into that engine's environment
 * on the computer and nowhere else.
 */
export const secret = query({
  args: { token: v.string(), name: v.literal("GEMINI_API_KEY") },
  handler: async (ctx, args): Promise<string | null> => {
    await authenticate(ctx, args.token);
    return await ctx.runQuery(internal.secrets.get, { name: args.name });
  },
});

/** Sign-ins and sign-outs the owner asked of this runner, waiting for it. */
export const queuedAuth = query({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<Array<{ engine: EngineKind; id: number; kind: "login" | "logout"; method?: string }>> => {
    const runner = await authenticate(ctx, args.token);
    return Object.entries(runner.engineAuth ?? {})
      .filter(([, request]) => request.status === "queued")
      .map(([engine, request]) => ({ engine: engine as EngineKind, id: request.id, kind: request.kind, ...(request.method ? { method: request.method } : {}) }));
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
          ...(request.method ? { method: request.method } : {}),
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
  /** Its CLI should be updated: it is older than Perry works with, or a newer release is out. */
  update?: EngineUpdate;
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
        const update = updateOf(status);
        return {
          ...(update ? { update } : {}),
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
  args: { key: v.string(), runnerId: v.id("runners"), engine: vEngine, kind: v.union(v.literal("login"), v.literal("logout")), method: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const runner = await ctx.db.get(args.runnerId);
    const label = ENGINE_LABELS[args.engine];
    if (!runner || !isOnline(runner)) throw new Error(`Start Perry on this computer before connecting ${label}.`);
    const status = statusesOf(runner).find((item) => item.kind === args.engine);
    // An engine too old for Perry is updated first: signing it in would lead nowhere.
    const old = tooOld(runner, args.engine);
    if (old && args.kind === "login") throw new Error(refusal(label, old, runner.name));
    if (!status?.installed) throw new Error(status?.error || status?.message || `${label} isn't installed on this computer.`);
    const current = runner.engineAuth?.[args.engine];
    if (current?.status === "queued" || current?.status === "running") throw new Error(`A ${label} sign-in is already in progress.`);
    await ctx.db.patch(runner._id, {
      engineAuth: { ...runner.engineAuth, [args.engine]: { id: (current?.id ?? 0) + 1, kind: args.kind, ...(args.method ? { method: args.method.slice(0, 40) } : {}), status: "queued" } },
    });
    return null;
  },
});
