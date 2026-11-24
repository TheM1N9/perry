import { ArgumentError } from "../server/validate";
import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { authenticate } from "./runner";
import { assertDashboardKey } from "./lib/auth";
import { saveMessages } from "./lib/agent";

const question = v.object({ id: v.string(), header: v.string(), question: v.string(), options: v.array(v.object({ label: v.string(), description: v.string() })), multiple: v.optional(v.boolean()) });
export async function pendingOwnerQuestions(ctx: QueryCtx): Promise<Doc<"userQuestions">[]> {
  const turns = await ctx.db.query("codexTurns").withIndex("by_status", q => q.eq("status", "running")).collect();
  const rows = await Promise.all(turns.filter(turn => !turn.stopRequested && !turn.guest && !turn.preparation).map(turn => ctx.db.query("userQuestions").withIndex("by_turn", q => q.eq("turnId", turn._id)).collect()));
  return rows.flat().filter(row => row.status === "pending");
}
export const request = mutation({
  args: { token: v.string(), turnId: v.id("codexTurns"), nativeId: v.string(), questions: v.array(question) },
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token), turn = await ctx.db.get(args.turnId);
    if (!turn || turn.runnerId !== runner._id || turn.status !== "running" || turn.stopRequested || turn.guest || turn.preparation) throw new ArgumentError("This turn cannot ask questions.");
    if (!args.questions.length || args.questions.length > 10 || new Set(args.questions.map(q => q.id)).size !== args.questions.length || args.nativeId.length > 200 || JSON.stringify(args.questions).length > 24000) throw new ArgumentError("Question is too large or invalid.");
    const existing = await ctx.db.query("userQuestions").withIndex("by_turn", q => q.eq("turnId", args.turnId).eq("nativeId", args.nativeId)).first();
    if (existing) return existing._id;
    const older = await ctx.db.query("userQuestions").withIndex("by_chat", q => q.eq("conversationId", turn.conversationId)).collect();
    for (const row of older.sort((a, b) => b.createdAt - a.createdAt).slice(20)) if (row.turnId !== turn._id) await ctx.db.delete(row._id);
    if (older.filter(row => row.turnId === turn._id).length >= 100) throw new ArgumentError("This turn has asked too many questions. Start a new reply.");
    return await ctx.db.insert("userQuestions", { conversationId: turn.conversationId, turnId: turn._id, nativeId: args.nativeId, questions: args.questions, status: "pending", createdAt: Date.now() });
  },
});
export const pending = query({
  args: { key: v.string(), conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const rows = await ctx.db.query("userQuestions").withIndex("by_chat", q => q.eq("conversationId", args.conversationId).eq("status", "pending")).collect();
    const live = await Promise.all(rows.map(async row => { const turn = await ctx.db.get(row.turnId); return turn?.status === "running" && !turn.stopRequested ? row : null; }));
    return live.filter(row => row !== null);
  },
});
export const pendingCount = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    return (await pendingOwnerQuestions(ctx)).length;
  },
});
export const answer = mutation({
  args: { key: v.string(), id: v.id("userQuestions"), answers: v.record(v.string(), v.array(v.string())) },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const request = await ctx.db.get(args.id), turn = request ? await ctx.db.get(request.turnId) : null;
    if (!request || request.status !== "pending" || turn?.status !== "running" || turn.stopRequested) throw new ArgumentError("This question is no longer waiting.");
    if (Object.keys(args.answers).some(id => !request.questions.some(q => q.id === id)) || request.questions.some(q => !args.answers[q.id]?.length || (!q.multiple && args.answers[q.id].length > 1)) || JSON.stringify(args.answers).length > 16000) throw new ArgumentError("Answer every question before continuing.");
    await ctx.db.patch(request._id, { answers: args.answers, status: "answered" });
    const chat = await ctx.db.get(request.conversationId);
    if (chat) await saveMessages(ctx, { threadId: chat.threadId, userId: chat.channel === "web" ? "web:dashboard" : `${chat.channel}:${chat.externalId}`, messages: [{ role: "user", content: `Answers to Perry's questions:\n${request.questions.map(question => `${question.question}\n${args.answers[question.id].join(", ")}`).join("\n\n")}` }] });
  },
});
export const response = query({
  args: { token: v.string(), id: v.id("userQuestions") },
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token), request = await ctx.db.get(args.id), turn = request ? await ctx.db.get(request.turnId) : null;
    if (!request || turn?.runnerId !== runner._id || turn.status !== "running" || turn.stopRequested) return { cancelled: true as const };
    return request.answers ? { answers: request.answers } : {};
  },
});
