import { ArgumentError } from "../server/validate";
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { randomBytes } from "node:crypto";
import { targetOf } from "./channels";
import { hide, savedValues } from "./vault";
import { sendMessage } from "./lib/telegram";
import { authenticate } from "./runner";
import { assertDashboardKey } from "./lib/auth";
import { saveMessages } from "./lib/agent";

const question = v.object({ id: v.string(), header: v.string(), question: v.string(), options: v.array(v.object({ label: v.string(), description: v.string() })), multiple: v.optional(v.boolean()) });

async function active(ctx: QueryCtx, request: Doc<"userQuestions">): Promise<boolean> {
  const turn = await ctx.db.get(request.turnId);
  return Boolean(turn?.status === "running" && !turn.stopRequested && !turn.guest && !turn.preparation && !turn.flush && !turn.checkpoint && turn.kind !== "compact" && !(await ctx.db.query("installation").first())?.paused);
}

async function phoneTarget(ctx: QueryCtx, conversationId: Id<"conversations">) {
  const owner = await ctx.db.query("installation").first();
  const target = await targetOf(ctx, conversationId);
  if (!owner?.claimedAt || owner.paused || !target || target.channel === "web") return null;
  if (target.channel === "telegram") return owner.ownerChannel === "telegram" && target.externalId === owner.ownerExternalId ? target : null;
  return target.externalId === owner.whatsappOwner && (await ctx.db.query("whatsappLink").first())?.wanted ? target : null;
}

/** Rechecked when a queued prompt leaves the server, and again when its answer arrives. */
export async function phonePrompt(ctx: QueryCtx, id: Id<"userQuestions">, index: number) {
  const request = await ctx.db.get(id);
  if (!request?.phone || request.status !== "pending" || !Number.isInteger(index) || index < 0 || !request.questions[index] || request.answers?.[request.questions[index].id]?.length || !await active(ctx, request)) return null;
  const target = await phoneTarget(ctx, request.conversationId);
  if (!target || target.channel !== request.phone.channel || target.externalId !== request.phone.externalId) return null;
  const q = request.questions[index];
  const text = [
    `Perry needs your answer${request.questions.length > 1 ? ` (${index + 1}/${request.questions.length})` : ""}`,
    q.header ? `${q.header}\n${q.question}` : q.question,
    ...q.options.map((option, i) => `${i + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`),
    `Reply to this message with ${q.options.length ? q.multiple ? "option numbers separated by commas, or your own answer" : "an option number or your own answer" : "your answer"}.`,
    `Or send /answer ${request.phone.code}.${index + 1} ${q.options.length ? "1" : "your answer"}`,
    q.options.length ? 'For a literal number, write "text: 2026".' : null,
  ].filter(Boolean).join("\n\n");
  return { channel: request.phone.channel, externalId: request.phone.externalId, text: hide(text, await savedValues(ctx)) };
}

async function settle(ctx: MutationCtx, request: Doc<"userQuestions">, answers: Record<string, string[]>) {
  await ctx.db.patch(request._id, { answers, status: "answered" });
  const chat = await ctx.db.get(request.conversationId);
  if (chat) await saveMessages(ctx, { threadId: chat.threadId, userId: chat.channel === "web" ? "web:dashboard" : `${chat.channel}:${chat.externalId}`, messages: [{ role: "user", content: `Answers to Perry's questions:\n${request.questions.map(q => `${q.question}\n${answers[q.id].join(", ")}`).join("\n\n")}` }] });
}

export async function pendingOwnerQuestions(ctx: QueryCtx): Promise<Doc<"userQuestions">[]> {
  const turns = await ctx.db.query("codexTurns").withIndex("by_status", q => q.eq("status", "running")).collect();
  const rows = await Promise.all(turns.filter(turn => !turn.stopRequested && !turn.guest && !turn.preparation).map(turn => ctx.db.query("userQuestions").withIndex("by_turn", q => q.eq("turnId", turn._id)).collect()));
  return rows.flat().filter(row => row.status === "pending");
}
export const request = mutation({
  args: { token: v.string(), turnId: v.id("codexTurns"), nativeId: v.string(), questions: v.array(question) },
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token), turn = await ctx.db.get(args.turnId);
    if (!turn || turn.runnerId !== runner._id || turn.status !== "running" || turn.stopRequested || turn.guest || turn.preparation || turn.flush || turn.checkpoint || turn.kind === "compact") throw new ArgumentError("This turn cannot ask questions.");
    if (!args.questions.length || args.questions.length > 10 || new Set(args.questions.map(q => q.id)).size !== args.questions.length || args.nativeId.length > 200 || JSON.stringify(args.questions).length > 24000) throw new ArgumentError("Question is too large or invalid.");
    const existing = await ctx.db.query("userQuestions").withIndex("by_turn", q => q.eq("turnId", args.turnId).eq("nativeId", args.nativeId)).first();
    if (existing) return existing._id;
    const older = await ctx.db.query("userQuestions").withIndex("by_chat", q => q.eq("conversationId", turn.conversationId)).collect();
    for (const row of older.sort((a, b) => b.createdAt - a.createdAt).slice(20)) if (row.turnId !== turn._id) await ctx.db.delete(row._id);
    if (older.filter(row => row.turnId === turn._id).length >= 100) throw new ArgumentError("This turn has asked too many questions. Start a new reply.");
    const target = !turn.flush && !turn.checkpoint && turn.kind !== "compact" ? await phoneTarget(ctx, turn.conversationId) : null;
    const id = await ctx.db.insert("userQuestions", { conversationId: turn.conversationId, turnId: turn._id, nativeId: args.nativeId, questions: args.questions, status: "pending", createdAt: Date.now(), ...(target ? { phone: { channel: target.channel, externalId: target.externalId, code: randomBytes(6).toString("hex") } } : {}) });
    if (target) for (let index = 0; index < args.questions.length; index++) {
      if (target.channel === "whatsapp") await ctx.runMutation(internal.whatsapp.sendQuestion, { id, index });
      else await ctx.scheduler.runAfter(0, internal.questions.promptOnTelegram, { id, index });
    }
    return id;
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
    if (!request || request.status !== "pending" || turn?.status !== "running" || !await active(ctx, request)) throw new ArgumentError("This question is no longer waiting.");
    if (Object.keys(args.answers).some(id => !request.questions.some(q => q.id === id)) || request.questions.some(q => !args.answers[q.id]?.length || (!q.multiple && args.answers[q.id].length > 1)) || JSON.stringify(args.answers).length > 16000) throw new ArgumentError("Answer every question before continuing.");
    await settle(ctx, request, args.answers);
  },
});
export const response = query({
  args: { token: v.string(), id: v.id("userQuestions") },
  handler: async (ctx, args) => {
    const runner = await authenticate(ctx, args.token), request = await ctx.db.get(args.id), turn = request ? await ctx.db.get(request.turnId) : null;
    if (!request || turn?.runnerId !== runner._id || !await active(ctx, request)) return { cancelled: true as const };
    return request.status === "answered" ? { answers: request.answers } : {};
  },
});

const promptArgs = { id: v.id("userQuestions"), index: v.number() };
export const currentPrompt = internalQuery({ args: promptArgs, handler: async (ctx, args) => await phonePrompt(ctx, args.id, args.index) });
export const claimTelegram = internalMutation({
  args: promptArgs,
  handler: async (ctx, args) => {
    const prompt = await phonePrompt(ctx, args.id, args.index);
    const request = await ctx.db.get(args.id);
    if (prompt?.channel !== "telegram" || !request?.phone || request.phone.telegram?.some(attempt => attempt.index === args.index)) return null;
    await ctx.db.patch(args.id, { phone: { ...request.phone, telegram: [...request.phone.telegram ?? [], { index: args.index, state: "sending", messageIds: [] }] } });
    return prompt;
  },
});
export const telegramOutcome = internalMutation({
  args: { ...promptArgs, messageId: v.optional(v.string()), state: v.optional(v.union(v.literal("sent"), v.literal("uncertain"))) },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.id);
    if (!request?.phone?.telegram) return null;
    await ctx.db.patch(args.id, { phone: { ...request.phone, telegram: request.phone.telegram.map(attempt => attempt.index !== args.index ? attempt : { ...attempt, state: args.state ?? attempt.state, messageIds: args.messageId && !attempt.messageIds.includes(args.messageId) ? [...attempt.messageIds, args.messageId] : attempt.messageIds }) } });
    return null;
  },
});
export const promptOnTelegram = internalAction({
  args: promptArgs,
  handler: async (ctx, args) => {
    const prompt = await ctx.runMutation(internal.questions.claimTelegram, args);
    if (!prompt) return null;
    try {
      const token = await ctx.runQuery(internal.secrets.get, { name: "TELEGRAM_BOT_TOKEN" });
      await sendMessage(token, prompt.externalId, prompt.text, {
        beforeSend: async () => {
          const current = await ctx.runQuery(internal.questions.currentPrompt, args);
          if (!current || current.text !== prompt.text) throw new Error("This question changed or is no longer waiting.");
        },
        onSent: async id => { await ctx.runMutation(internal.questions.telegramOutcome, { ...args, messageId: String(id) }); },
      });
      await ctx.runMutation(internal.questions.telegramOutcome, { ...args, state: "sent" });
    } catch {
      // Telegram may have accepted the request before the connection was lost.
      await ctx.runMutation(internal.questions.telegramOutcome, { ...args, state: "uncertain" });
    }
    return null;
  },
});

export const answerFromPhone = internalMutation({
  args: { channel: v.union(v.literal("telegram"), v.literal("whatsapp")), senderId: v.string(), text: v.string(), replyTo: v.optional(v.string()) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args): Promise<string | null> => {
    const command = /^\/answer\s+([a-f0-9]{12})\.(\d+)\s+([\s\S]+)$/i.exec(args.text.trim());
    const owner = await ctx.db.query("installation").first();
    if (!owner?.claimedAt || (args.channel === "telegram" ? owner.ownerChannel !== "telegram" || owner.ownerExternalId !== args.senderId : owner.whatsappOwner !== args.senderId)) return null;
    if (!command && /^\/answer\b/i.test(args.text.trim())) return "Use /answer followed by the question code and your answer, as shown in Perry's question.";
    if (!command && args.text.trim().startsWith("/")) return null;
    let request: Doc<"userQuestions"> | null = null;
    let index = -1;
    if (command) {
      request = await ctx.db.query("userQuestions").withIndex("by_phone_code", q => q.eq("phone.code", command[1].toLowerCase())).unique();
      index = Number(command[2]) - 1;
    } else if (args.replyTo) {
      if (args.channel === "whatsapp") {
        const quoted = await ctx.db.query("whatsappOutbox").withIndex("by_message", q => q.eq("messageId", args.replyTo)).unique();
        if (quoted?.to === args.senderId && quoted.question) {
          request = await ctx.db.get(quoted.question.id);
          index = quoted.question.index;
        } else {
          const rows = await ctx.db.query("userQuestions").withIndex("by_phone", q => q.eq("phone.channel", "whatsapp").eq("phone.externalId", args.senderId)).collect();
          request = rows.find(row => row.phone?.whatsapp?.some(attempt => attempt.messageIds.includes(args.replyTo!))) ?? null;
          if (!request) return null;
          index = request.phone!.whatsapp!.find(attempt => attempt.messageIds.includes(args.replyTo!))!.index;
        }
      } else {
        const rows = await ctx.db.query("userQuestions").withIndex("by_phone", q => q.eq("phone.channel", "telegram").eq("phone.externalId", args.senderId)).collect();
        request = rows.find(row => row.phone?.telegram?.some(attempt => attempt.messageIds.includes(args.replyTo!))) ?? null;
        if (!request) return null;
        index = request.phone!.telegram!.find(attempt => attempt.messageIds.includes(args.replyTo!))!.index;
      }
    } else return null;
    if (!request || !Number.isInteger(index) || !request.questions[index] || !await phonePrompt(ctx, request._id, index) || request.phone?.channel !== args.channel || request.phone.externalId !== args.senderId) return "That question has already been answered or is no longer waiting.";
    if (!command) {
      if (args.channel === "telegram" && request.phone.telegram?.find(attempt => attempt.index === index)?.state !== "sent") return "The complete question has not been confirmed delivered. Use its /answer code, or answer in the dashboard.";
      if (args.channel === "whatsapp") {
        const delivery = request.phone.whatsapp?.find(attempt => attempt.index === index);
        if (!delivery?.messageIds.length || delivery.messageIds.some(id => !delivery.sentIds.includes(id))) return "The complete question is still arriving. Wait for all its parts, or use its /answer code.";
      }
    }
    const q = request.questions[index];
    const text = (command ? command[3] : args.text).trim();
    const literal = /^text:\s*([\s\S]+)$/i.exec(text);
    const numeric = !literal && q.options.length && /^\d+(?:\s*,\s*\d+)*$/.test(text);
    let values: string[];
    if (numeric) {
      const numbers = [...new Set(text.split(",").map(value => Number(value.trim())))];
      if ((!q.multiple && numbers.length !== 1) || numbers.some(n => n < 1 || n > q.options.length)) return `Choose ${q.multiple ? "option numbers" : "one option number"} from 1 to ${q.options.length}, or write your own answer. For a literal number, start with text:.`;
      values = numbers.map(n => q.options[n - 1].label);
    } else values = [(literal ? literal[1] : text).trim()];
    const answers = { ...request.answers, [q.id]: values };
    if (!values[0] || JSON.stringify(answers).length > 16000) return "Please send a non-empty answer under 16,000 characters.";
    const remaining = request.questions.filter(question => !answers[question.id]?.length).length;
    if (remaining) await ctx.db.patch(request._id, { answers });
    else await settle(ctx, request, answers);
    return remaining ? `Answer saved. ${remaining} ${remaining === 1 ? "question still needs" : "questions still need"} your answer.` : "Answered. I’ll continue the same work.";
  },
});
