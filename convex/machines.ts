import { ArgumentError } from "../server/validate";
import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { assertDashboardKey } from "./lib/auth";
import { authenticate } from "./runner";
import { isOnline } from "./engines";
import { machineCommand } from "../lib/machine-protocol";
import { pausedAt } from "./pause";
import { assertWorkspaceIdle } from "./projects";

async function context(ctx: QueryCtx, conversationId: Id<"conversations">) {
  const chat = await ctx.db.get(conversationId);
  if (!chat || chat.contactId || chat.providerAgent) throw new ArgumentError("Open an owner chat to use computer tools.");
  const project = chat.projectId ? await ctx.db.get(chat.projectId) : null;
  const runners = (await ctx.db.query("runners").collect()).filter(runner => !runner.revoked).sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  const runnerId = project?.workspace?.runnerId ?? project?.runnerId ?? chat.codexRunnerId;
  const runner = runnerId ? runners.find(runner => runner._id === runnerId) : runners.find(isOnline);
  return { chat, project, runners, runner, cwd: project?.workspace?.path };
}
export const state = query({
  args: { key: v.string(), conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const found = await context(ctx, args.conversationId);
    return { runner: found.runner ? { id: found.runner._id, name: found.runner.name, online: isOnline(found.runner) } : null, runners: found.runners.map(runner => ({ id: runner._id, name: runner.name, online: isOnline(runner) })), workspace: found.project?.workspace ?? null,
      workspaceRequest: found.project?.workspaceRequestId ? await ctx.db.get(found.project.workspaceRequestId) : null,
      terminals: (await ctx.db.query("terminalSessions").withIndex("by_chat", q => q.eq("conversationId", args.conversationId)).collect()).filter(session => session.runnerId === found.runner?._id && (!found.cwd || session.cwd === found.cwd)) };
  },
});
export const request = mutation({
  args: { key: v.string(), conversationId: v.id("conversations"), requestId: v.string(), input: v.string(), runnerId: v.optional(v.id("runners")) },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const command = machineCommand.parse(JSON.parse(args.input));
    const found = await context(ctx, args.conversationId);
    const existing = await ctx.db.query("machineRequests").withIndex("by_request", q => q.eq("conversationId", args.conversationId).eq("requestId", args.requestId)).first();
    if (existing) { if (existing.input !== JSON.stringify(command)) throw new ArgumentError("This request id was already used."); return existing._id; }
    if (args.requestId.length > 128) throw new ArgumentError("Invalid request id.");
    if (await pausedAt(ctx) && command.kind !== "terminal.close" && command.kind !== "device.close") throw new ArgumentError("Resume Perry before starting computer work.");
    const runner = args.runnerId ? found.runners.find(runner => runner._id === args.runnerId) : found.runner;
    if (!runner || !isOnline(runner)) throw new ArgumentError("Start the runner on this chat's computer first.");
    if (args.runnerId && command.kind !== "workspace.setup" && runner._id !== found.runner?._id) throw new ArgumentError("This request belongs to another computer.");
    if (command.kind === "workspace.setup") {
      if (!found.project) throw new ArgumentError("Add this chat to a project first.");
      if (found.project.workspaceRequestId) throw new ArgumentError("This project's workspace is already being configured.");
      const chats = await ctx.db.query("conversations").withIndex("by_project", q => q.eq("projectId", found.project!._id)).collect();
      for (const chat of chats) await assertWorkspaceIdle(ctx, chat);
    }
    const previous = await ctx.db.query("machineRequests").withIndex("by_chat", q => q.eq("conversationId", args.conversationId)).order("desc").collect();
    if (previous.filter(request => request.status === "queued" || request.status === "running").length >= 32) throw new ArgumentError("Wait for the computer to finish its pending requests.");
    for (const request of previous.slice(50)) if (request.status === "done" || request.status === "error") await ctx.db.delete(request._id);
    if (!found.chat.codexRunnerId && command.kind !== "workspace.setup") await ctx.db.patch(found.chat._id, { codexRunnerId: runner._id });
    if (found.project && !found.project.runnerId && command.kind !== "workspace.setup") await ctx.db.patch(found.project._id, { runnerId: runner._id });
    if (found.project?.workspaceRequestId) throw new ArgumentError("Wait for this project's workspace to finish moving.");
    const id = await ctx.db.insert("machineRequests", { conversationId: args.conversationId, runnerId: runner._id, requestId: args.requestId, input: JSON.stringify(command), ...(found.project ? { projectId: found.project._id } : {}), ...(found.cwd && command.kind !== "workspace.setup" ? { cwd: found.cwd } : {}), status: "queued", createdAt: Date.now(), updatedAt: Date.now() });
    if (command.kind === "workspace.setup") await ctx.db.patch(found.project!._id, { workspaceRequestId: id });
    return id;
  },
});
export const queued = query({
  args: { token: v.string() },
  handler: async (ctx, args) => { const runner = await authenticate(ctx, args.token); return await ctx.db.query("machineRequests").withIndex("by_runner", q => q.eq("runnerId", runner._id).eq("status", "queued")).order("asc").take(32); },
});
export const cancelWorkspace = mutation({
  args: { key: v.string(), conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const found = await context(ctx, args.conversationId), id = found.project?.workspaceRequestId;
    if (!id) return;
    const request = await ctx.db.get(id);
    if (request?.status === "running") throw new ArgumentError("The workspace operation has started. Wait for its result before changing it.");
    if (request?.status === "queued") await ctx.db.patch(id, { status: "error", error: "Workspace configuration cancelled before it started.", updatedAt: Date.now() });
    await ctx.db.patch(found.project!._id, { workspaceRequestId: undefined });
  },
});
export const result = query({
  args: { key: v.string(), id: v.id("machineRequests") },
  handler: async (ctx, args) => { assertDashboardKey(args.key); const request = await ctx.db.get(args.id); if (request) await context(ctx, request.conversationId); return request; },
});
export const recover = mutation({
  args: { token: v.string(), receipts: v.optional(v.array(v.id("machineRequests"))) },
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    for (const request of await ctx.db.query("machineRequests").withIndex("by_runner", q => q.eq("runnerId", runner._id).eq("status", "running")).collect()) {
      if (args.receipts?.includes(request._id)) continue;
      await ctx.db.patch(request._id, { status: "error", error: "The runner restarted during this operation. Inspect the current state before trying it again.", updatedAt: Date.now() });
      if (request.projectId && (await ctx.db.get(request.projectId))?.workspaceRequestId === request._id) await ctx.db.patch(request.projectId, { workspaceRequestId: undefined });
    }
    for (const terminal of await ctx.db.query("terminalSessions").collect()) if (terminal.runnerId === runner._id && terminal.status === "running") await ctx.db.patch(terminal._id, { status: "exited", updatedAt: Date.now() });
  },
});
export const claim = mutation({
  args: { token: v.string(), id: v.id("machineRequests") },
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token), request = await ctx.db.get(args.id);
    if (!request || request.runnerId !== runner._id || request.status !== "queued") return null;
    const command = machineCommand.parse(JSON.parse(request.input));
    if (await pausedAt(ctx) && command.kind !== "terminal.close" && command.kind !== "device.close") return null;
    if (Date.now() - request.createdAt > 120000) {
      await ctx.db.patch(request._id, { status: "error", error: "This computer request expired. Try again.", updatedAt: Date.now() });
      if (request.projectId && (await ctx.db.get(request.projectId))?.workspaceRequestId === request._id) await ctx.db.patch(request.projectId, { workspaceRequestId: undefined });
      return null;
    }
    const found = await context(ctx, request.conversationId);
    if (command.kind !== "workspace.setup" && (found.runner?._id !== runner._id || found.cwd !== request.cwd)) { await ctx.db.patch(request._id, { status: "error", error: "This chat's workspace changed. Open the panel again.", updatedAt: Date.now() }); return null; }
    await ctx.db.patch(request._id, { status: "running", updatedAt: Date.now() }); return request;
  },
});
export const finish = mutation({
  args: { token: v.string(), id: v.id("machineRequests"), result: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token), request = await ctx.db.get(args.id);
    if (!request || request.runnerId !== runner._id || request.status !== "running") return;
    if ((args.result?.length ?? 0) > 2_000_000) throw new ArgumentError("Computer result exceeded its limit.");
    const command = machineCommand.parse(JSON.parse(request.input));
    if (command.kind === "workspace.setup" && request.projectId && (await ctx.db.get(request.projectId))?.workspaceRequestId === request._id) await ctx.db.patch(request.projectId, { workspaceRequestId: undefined });
    if (command.kind === "workspace.setup" && request.projectId && !args.error) {
      const result = JSON.parse(args.result ?? "{}") as { path: string; repository?: string; branch?: string };
      if (!result.path || result.path.length > 4096) throw new ArgumentError("Invalid workspace result.");
      if (await ctx.db.get(request.projectId)) {
        await ctx.db.patch(request.projectId, { runnerId: runner._id, workspace: { runnerId: runner._id, path: result.path, mode: command.mode, ...(result.repository ? { repository: result.repository } : {}), ...(result.branch ? { branch: result.branch } : {}) }, updatedAt: Date.now() });
        for (const chat of await ctx.db.query("conversations").withIndex("by_project", q => q.eq("projectId", request.projectId)).collect()) {
          await ctx.db.patch(chat._id, { codexRunnerId: runner._id, resume: undefined, codexThreadId: undefined });
          for (const turn of await ctx.db.query("codexTurns").withIndex("by_conversation_status", q => q.eq("conversationId", chat._id).eq("status", "queued")).collect()) if (turn.runnerId) await ctx.db.patch(turn._id, { runnerId: runner._id });
        }
      }
    }
    await ctx.db.patch(request._id, { status: args.error ? "error" : "done", result: args.result, error: args.error?.slice(0, 4000), updatedAt: Date.now() });
  },
});
export const terminal = mutation({
  args: { token: v.string(), conversationId: v.id("conversations"), sessionId: v.string(), cwd: v.string(), output: v.string(), offset: v.number(), status: v.union(v.literal("running"), v.literal("exited")) },
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token);
    const found = await context(ctx, args.conversationId);
    if (found.runner?._id !== runner._id || (found.cwd && found.cwd !== args.cwd)) return false;
    if (args.output.length > 131072 || args.sessionId.length > 150) throw new ArgumentError("Terminal output exceeds its limit.");
    const existing = await ctx.db.query("terminalSessions").withIndex("by_runner", q => q.eq("runnerId", runner._id).eq("sessionId", args.sessionId)).first();
    const { token: _token, ...data } = args;
    if (existing) { if (args.offset >= existing.offset) await ctx.db.patch(existing._id, { ...data, updatedAt: Date.now() }); }
    else await ctx.db.insert("terminalSessions", { ...data, runnerId: runner._id, updatedAt: Date.now() });
    const sessions = await ctx.db.query("terminalSessions").withIndex("by_chat", q => q.eq("conversationId", args.conversationId)).collect();
    for (const session of sessions.filter(session => session.status === "exited").sort((a, b) => b.updatedAt - a.updatedAt).slice(4)) await ctx.db.delete(session._id);
    return true;
  },
});
