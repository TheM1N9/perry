import { statSync } from "node:fs";
import { join } from "node:path";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { previewOf } from "./lib/library";
import { associate, workspaceSafe } from "./lib/workspace";
import { HOME } from "../runner/home";
import { APPROVAL_TTL_MS, BRAIN_TTL_MS } from "./approvals";
import { describeStep } from "./lib/activity";
import { vLibraryKind } from "./schema";

const scopeArgs = { key: v.string(), conversationId: v.id("conversations"), scope: v.union(v.literal("chat"), v.literal("project")) };
type ScopeArgs = { key: string; conversationId: Id<"conversations">; scope: "chat" | "project" };

async function scopeOf(ctx: QueryCtx, args: ScopeArgs) {
  assertDashboardKey(args.key);
  const chat = await ctx.db.get(args.conversationId);
  if (!chat || chat.contactId) throw new Error("This workspace is unavailable.");
  if (args.scope === "project" && (!chat.projectId || !await ctx.db.get(chat.projectId))) throw new Error("This chat has no project.");
  return { chat, key: args.scope === "project" ? `project:${chat.projectId}` : `chat:${chat._id}` };
}

export const settings = query({
  args: { key: v.string() },
  handler: (_ctx, args) => { assertDashboardKey(args.key); return { enabled: process.env.PERRY_WORKSPACE === "1" }; },
});

async function member(ctx: QueryCtx, args: ScopeArgs, libraryId: Id<"library">) {
  const { chat, key } = await scopeOf(ctx, args);
  const candidates = await ctx.db.query("workspaceFiles").withIndex("by_library", (q) => q.eq("libraryId", libraryId)).take(500);
  const association = candidates.find((row) => args.scope === "chat" ? row.conversationId === chat._id : row.projectId === chat.projectId);
  const item = await ctx.db.get(libraryId);
  if (!association || !item || !workspaceSafe(item.localPath, item.name)) return null;
  const source = await ctx.db.get(association.sourceConversationId);
  if (!source || source.contactId) return null;
  return { item, association, key };
}

export type WorkspaceFile = {
  id: Id<"library">; name: string; kind: Doc<"library">["kind"]; contentType: string; size: number;
  role: Doc<"workspaceFiles">["role"]; provenance: Doc<"workspaceFiles">["provenance"];
  status: "ready" | "unavailable"; preview: ReturnType<typeof previewOf>; url: string;
  pinned: boolean; hidden: boolean; createdAt: number; group: string;
  versionOf?: Id<"library">; versionRoot?: Id<"library">; versionLabel?: string; latest: boolean;
  source: { conversationId: Id<"conversations">; title: string; messageKey?: string; taskId?: Id<"tasks">; runId?: Id<"runs"> };
};

async function fileView(ctx: QueryCtx, item: Doc<"library">, association: Doc<"workspaceFiles">, scopeKey: string, args: ScopeArgs): Promise<WorkspaceFile> {
  const view = await ctx.db.query("workspaceViews").withIndex("by_item", (q) => q.eq("scope", scopeKey).eq("libraryId", item._id)).first();
  const source = await ctx.db.get(association.sourceConversationId);
  const task = association.taskId ? await ctx.db.get(association.taskId) : null;
  let available = false;
  if (item.localPath) { try { available = statSync(item.localPath).isFile(); } catch {} }
  else if (item.storageId && await ctx.storage.getMetadata(item.storageId)) {
    try { available = statSync(join(HOME, "storage", item.storageId)).isFile(); } catch {}
  }
  const next = await ctx.db.query("library").withIndex("by_version", (q) => q.eq("versionOf", item._id)).first();
  const params = new URLSearchParams({ conversation: args.conversationId, scope: args.scope });
  return {
    id: item._id, name: item.name, kind: item.kind, contentType: item.contentType, size: item.size,
    role: association.role, provenance: association.provenance, status: available ? "ready" : "unavailable",
    preview: previewOf(item.contentType, item.name), url: `/api/media/workspace/${item._id}?${params}`,
    pinned: view?.pinned ?? false, hidden: view?.hidden ?? false, createdAt: association.createdAt,
    group: task?.title ?? (association.role === "input" ? "Inputs" : source?.title || "Outputs"),
    versionOf: item.versionOf, versionRoot: item.versionRoot, versionLabel: item.versionLabel,
    latest: !next || !await member(ctx, args, next._id),
    source: { conversationId: association.sourceConversationId, title: task?.title ?? source?.title ?? "Chat", messageKey: association.messageKey, taskId: association.taskId, runId: association.runId },
  };
}

/** Indexed membership pages. Filters never fall back to global Library or filesystem discovery. */
export const files = query({
  args: { ...scopeArgs, paginationOpts: paginationOptsValidator, working: v.boolean(), hidden: v.boolean(), kind: v.optional(vLibraryKind) },
  handler: async (ctx, args): Promise<{ page: WorkspaceFile[]; isDone: boolean; continueCursor: string }> => {
    const { chat, key } = await scopeOf(ctx, args);
    const kind = args.kind;
    let rows = kind
      ? args.scope === "project"
        ? ctx.db.query("workspaceFiles").withIndex("by_project_kind", (q) => q.eq("projectId", chat.projectId).eq("kind", kind))
        : ctx.db.query("workspaceFiles").withIndex("by_conversation_kind", (q) => q.eq("conversationId", chat._id).eq("kind", kind))
      : args.scope === "project"
        ? ctx.db.query("workspaceFiles").withIndex("by_project", (q) => q.eq("projectId", chat.projectId))
        : ctx.db.query("workspaceFiles").withIndex("by_conversation", (q) => q.eq("conversationId", chat._id));
    if (!args.working) rows = rows.filter((q) => q.neq(q.field("role"), "working"));
    const page = await rows.order("asc").paginate({ ...args.paginationOpts, numItems: Math.min(args.paginationOpts.numItems, 500) });
    const files: WorkspaceFile[] = [];
    const seen = new Set<string>();
    for (const row of page.page) {
      if (seen.has(row.libraryId) || (!args.working && row.role === "working")) continue;
      const item = await ctx.db.get(row.libraryId);
      const source = await ctx.db.get(row.sourceConversationId);
      if (!item || !source || source.contactId || !workspaceSafe(item.localPath, item.name) || (args.kind && item.kind !== args.kind)) continue;
      seen.add(row.libraryId);
      const file = await fileView(ctx, item, row, key, args);
      if (!file.hidden || args.hidden) files.push(file);
    }
    return { ...page, page: files };
  },
});

export const get = query({
  args: { ...scopeArgs, id: v.string() },
  handler: async (ctx, args): Promise<WorkspaceFile | null> => {
    assertDashboardKey(args.key);
    const id = ctx.db.normalizeId("library", args.id);
    if (!id) return null;
    const found = await member(ctx, args, id);
    return found ? await fileView(ctx, found.item, found.association, found.key, args) : null;
  },
});

/** A shortcut to a registered output's terminal version, never a guessed final filename. */
export const latest = query({
  args: scopeArgs,
  handler: async (ctx, args): Promise<WorkspaceFile | null> => {
    const { chat, key } = await scopeOf(ctx, args);
    const rows = await (args.scope === "project"
      ? ctx.db.query("workspaceFiles").withIndex("by_project_role", (q) => q.eq("projectId", chat.projectId).eq("role", "output"))
      : ctx.db.query("workspaceFiles").withIndex("by_conversation_role", (q) => q.eq("conversationId", chat._id).eq("role", "output"))).order("desc").take(50);
    for (const row of rows) {
      const found = await member(ctx, args, row.libraryId);
      if (!found) continue;
      const file = await fileView(ctx, found.item, found.association, key, args);
      if (file.latest && !file.hidden) return file;
    }
    return null;
  },
});

/** The media route checks scope again; knowing a Library ID is insufficient. */
export const file = query({
  args: { ...scopeArgs, id: v.id("library") },
  handler: async (ctx, args): Promise<{ path: string; name: string; contentType: string } | null> => {
    const found = await member(ctx, args, args.id);
    if (!found) return null;
    const { item } = found;
    const path = item.localPath ?? (item.storageId ? join(HOME, "storage", item.storageId) : null);
    return path ? { path, name: item.name, contentType: item.contentType } : null;
  },
});

export const setView = mutation({
  args: { ...scopeArgs, id: v.id("library"), pinned: v.optional(v.boolean()), hidden: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const found = await member(ctx, args, args.id);
    if (!found) throw new Error("This file does not belong to this workspace.");
    const existing = await ctx.db.query("workspaceViews").withIndex("by_item", (q) => q.eq("scope", found.key).eq("libraryId", args.id)).first();
    const values = { pinned: args.pinned ?? existing?.pinned ?? false, hidden: args.hidden ?? existing?.hidden ?? false };
    if (existing) await ctx.db.patch(existing._id, values);
    else await ctx.db.insert("workspaceViews", { scope: found.key, libraryId: args.id, ...values });
  },
});

export const attach = mutation({
  args: { key: v.string(), conversationId: v.id("conversations"), id: v.id("library") },
  handler: async (ctx, args) => {
    const { chat } = await scopeOf(ctx, { ...args, scope: "chat" });
    const item = await ctx.db.get(args.id);
    if (!item || !workspaceSafe(item.localPath, item.name)) throw new Error("This Library item cannot be attached.");
    if (item.conversationId && (await ctx.db.get(item.conversationId))?.contactId) throw new Error("This Library item is unavailable.");
    await associate(ctx, item, chat, { role: "input", provenance: "attached" });
  },
});

export type WorkspaceWork = {
  id: string; title: string; status: string; currentStep?: string; error?: string;
  conversationId: Id<"conversations">; taskId?: Id<"tasks">; runId?: Id<"runs">; updatedAt: number;
  plan: Doc<"tasks">["plan"];
  outputs: Array<Pick<WorkspaceFile, "id" | "name" | "status">>;
};

/** Read the actual lifecycle; no second task/progress store. History is bounded and expanded deliberately. */
export const work = query({
  args: { ...scopeArgs, history: v.boolean() },
  handler: async (ctx, args): Promise<WorkspaceWork[]> => {
    const { chat } = await scopeOf(ctx, args);
    const approvals = await ctx.db.query("approvals").withIndex("by_status", (q) => q.eq("status", "pending")).take(100);
    const waitingIn = (id: Id<"conversations">) => approvals.some((approval) => approval.conversationId === id && approval.createdAt + (approval.kind === "brain" ? BRAIN_TTL_MS : APPROVAL_TTL_MS) > Date.now());
    const outputs = async (rows: Doc<"workspaceFiles">[]): Promise<WorkspaceWork["outputs"]> => {
      const result: WorkspaceWork["outputs"] = [];
      for (const id of new Set(rows.filter((row) => row.role === "output").map((row) => row.libraryId))) {
        const found = await member(ctx, args, id);
        if (!found) continue;
        const file = await fileView(ctx, found.item, found.association, found.key, args);
        if (!file.hidden) result.push({ id, name: file.name, status: file.status });
      }
      return result;
    };
    const chats = args.scope === "project"
      ? await ctx.db.query("conversations").withIndex("by_project", (q) => q.eq("projectId", chat.projectId)).order("desc").take(100)
      : [chat];
    const result: WorkspaceWork[] = [];
    const seenTasks = new Set<string>();
    for (const source of chats.filter((source) => !source.contactId)) {
      const tasks = await ctx.db.query("tasks").withIndex("by_origin", (q) => q.eq("origin", source._id)).order("desc").take(args.history ? 100 : 25);
      const own = await ctx.db.query("tasks").withIndex("by_conversation", (q) => q.eq("conversationId", source._id)).take(25);
      for (const task of [...tasks, ...own]) {
        if (seenTasks.has(task._id)) continue;
        seenTasks.add(task._id);
        if (!args.history && ["done", "cancelled"].includes(task.status) && Date.now() - task.updatedAt > 86_400_000) continue;
        const status = task.status === "blocked" || (task.status === "running" && task.conversationId && waitingIn(task.conversationId)) || (task.status === "queued" && task.waiting && task.waiting.until > Date.now()) ? "waiting" : task.status;
        const related = await ctx.db.query("workspaceFiles").withIndex("by_task", (q) => q.eq("taskId", task._id)).take(50);
        result.push({ id: task._id, title: task.title, status, currentStep: task.question ?? task.waiting?.why ?? task.plan.find((step) => step.status === "active")?.title, error: task.error, conversationId: task.conversationId ?? source._id, taskId: task._id, updatedAt: task.updatedAt, plan: task.plan, outputs: await outputs(related) });
      }
      if (source.taskId) continue;
      const runs = await ctx.db.query("runs").withIndex("by_conversation", (q) => q.eq("conversationId", source._id)).order("desc").take(args.history ? 50 : 10);
      for (const run of runs) {
        const spans = await ctx.db.query("runSpans").withIndex("by_run", (q) => q.eq("runId", run._id)).order("desc").take(100);
        const step = spans.find((span) => span.kind !== "reasoning" && span.status === "running");
        const related = await ctx.db.query("workspaceFiles").withIndex("by_run", (q) => q.eq("runId", run._id)).take(50);
        result.push({ id: run._id, title: run.prompt.slice(0, 100) || source.title || "Chat", status: run.status === "running" ? waitingIn(source._id) ? "waiting" : "running" : run.status === "ok" ? "done" : "failed", currentStep: step ? describeStep(step).label : undefined, error: run.error, conversationId: source._id, runId: run._id, updatedAt: run.finishedAt ?? run.startedAt, plan: [], outputs: await outputs(related) });
      }
    }
    return result.sort((a, b) => Number(["done", "failed", "cancelled"].includes(a.status)) - Number(["done", "failed", "cancelled"].includes(b.status)) || b.updatedAt - a.updatedAt).slice(0, args.history ? 100 : 25);
  },
});
