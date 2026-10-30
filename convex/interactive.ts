import { v } from "convex/values";
import { z } from "zod";
import { createHash } from "node:crypto";
import { api } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query, type QueryCtx, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertDashboardKey } from "./lib/auth";
import { INTERACTIVE_ANSWER, INTERACTIVE_DRAFT, migrateValues, parseDefinition, parseValues, type Definition, type Values } from "../lib/interactive";

export type Artifact = { id: Id<"interactiveAnswers">; conversationId: Id<"conversations">; lifecycle: "draft" | "answered"; link: string; revision: number; definition: Definition; values: Values; updatedAt: number; createdAt: number; canUndo: boolean };
export const enabled = () => process.env.PERRY_INTERACTIVE_ANSWERS !== "0";
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function requestId(id: string) { if (!/^[\w-]{1,80}$/.test(id)) throw new Error("Use a stable request id of at most 80 characters."); }

async function provenance(ctx: QueryCtx, conversationId: Id<"conversations">, definition: Definition) {
  if (definition.provenance.kind !== "retrieved") return;
  for (const source of definition.provenance.sources) {
    const id = source.receipt ? ctx.db.normalizeId("interactiveSources", source.receipt) : null;
    const receipt = id ? await ctx.db.get(id) : null;
    if (!receipt || receipt.conversationId !== conversationId) throw new Error("Retrieved data needs a sourceReceipt from this conversation's successful read_page, internet_read or read-only run_action.");
    if (source.fetchedAt !== receipt.fetchedAt || source.label !== receipt.label || source.url !== receipt.url) throw new Error("Source metadata must match its server-stamped receipt.");
  }
}

export const recordSource = internalMutation({
  args: { conversationId: v.id("conversations"), label: v.string(), url: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ receipt: string; label: string; fetchedAt: string; url?: string } | null> => {
    if (!enabled()) return null;
    await scope(ctx, args.conversationId);
    const rows = await ctx.db.query("interactiveSources").withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId)).collect();
    // At most 100 read receipts per conversation; receipts used by artifacts stay with them.
    if (rows.length >= 100) return null;
    const source = { ...args, label: args.label.slice(0, 200), fetchedAt: new Date().toISOString() };
    const receipt = await ctx.db.insert("interactiveSources", source);
    return { receipt, label: source.label, fetchedAt: source.fetchedAt, ...(source.url ? { url: source.url } : {}) };
  },
});

async function scope(ctx: QueryCtx, id: Id<"conversations">) {
  if (!enabled()) throw new Error("Interactive answers are disabled.");
  const chat = await ctx.db.get(id);
  if (!chat || chat.contactId) throw new Error("This is not an owner's conversation.");
  return chat;
}

function view(row: Doc<"interactiveAnswers">): Artifact {
  const definition = parseDefinition(JSON.parse(row.definition));
  return { id: row._id, conversationId: row.conversationId, lifecycle: row.answeredAt ? "answered" : "draft", link: `/chat/${row.conversationId}#interactive-${row._id}`, revision: row.revision, definition, values: parseValues(definition, JSON.parse(row.values)), updatedAt: row.updatedAt, createdAt: row.createdAt, canUndo: Boolean(row.previous) };
}

async function artifact(ctx: QueryCtx, conversationId: Id<"conversations">, id: Id<"interactiveAnswers">) {
  await scope(ctx, conversationId);
  const row = await ctx.db.get(id);
  if (!row || row.conversationId !== conversationId) throw new Error("Interactive answer is not in this conversation.");
  return row;
}

async function turn(ctx: MutationCtx, conversationId: Id<"conversations">, turnId: Id<"codexTurns">) {
  await scope(ctx, conversationId);
  const row = await ctx.db.get(turnId);
  if (!row || row.conversationId !== conversationId || row.guest || row.status !== "running" || row.stopRequested || row.stopped) throw new Error("This interactive answer's turn is no longer running.");
  return row;
}

export const list = query({
  args: { key: v.string(), conversationId: v.id("conversations") },
  handler: async (ctx, args): Promise<Artifact[]> => {
    assertDashboardKey(args.key);
    if (!enabled()) return [];
    await scope(ctx, args.conversationId);
    return (await ctx.db.query("interactiveAnswers").withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId)).collect()).map(view);
  },
});

export const forAgent = internalQuery({
  args: { conversationId: v.id("conversations"), id: v.optional(v.id("interactiveAnswers")) },
  handler: async (ctx, args): Promise<Artifact[]> => {
    if (!enabled()) return [];
    await scope(ctx, args.conversationId);
    if (args.id) return [view(await artifact(ctx, args.conversationId, args.id))];
    return (await ctx.db.query("interactiveAnswers").withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId)).collect()).map(view);
  },
});

export const create = internalMutation({
  args: { conversationId: v.id("conversations"), turnId: v.id("codexTurns"), requestId: v.string(), definition: v.string() },
  handler: async (ctx, args): Promise<Artifact> => {
    const running = await turn(ctx, args.conversationId, args.turnId);
    requestId(args.requestId);
    const definition = parseDefinition(JSON.parse(args.definition));
    await provenance(ctx, args.conversationId, definition);
    const rows = await ctx.db.query("interactiveAnswers").withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId)).collect();
    const existing = rows.find((row) => row.requestId === args.requestId);
    if (existing) {
      if (existing.creationHash !== fingerprint(definition)) throw new Error("This creation request id already belongs to another definition.");
      return view(existing);
    }
    if (rows.length >= 20) throw new Error("This conversation has reached its 20 interactive answer limit.");
    const now = Date.now();
    const id = await ctx.db.insert("interactiveAnswers", {
      conversationId: args.conversationId, requestId: args.requestId, creationHash: fingerprint(definition), schemaVersion: 1, revision: 1,
      definition: JSON.stringify(definition), values: JSON.stringify(migrateValues(definition)), createdAt: now, updatedAt: now, lastTurnAt: running._creationTime,
      generationRunId: running.runId, revisions: 0, saves: 0, conflicts: 0, restorations: 0, errors: 0,
    });
    return view((await ctx.db.get(id))!);
  },
});

export const revise = internalMutation({
  args: { conversationId: v.id("conversations"), turnId: v.id("codexTurns"), id: v.id("interactiveAnswers"), expectedRevision: v.number(), definition: v.string(), requestId: v.string() },
  handler: async (ctx, args): Promise<Artifact> => {
    const running = await turn(ctx, args.conversationId, args.turnId);
    requestId(args.requestId);
    const row = await artifact(ctx, args.conversationId, args.id);
    if (row.answeredAt) throw new Error("This question has already been answered. Create a new question instead.");
    const definition = parseDefinition(JSON.parse(args.definition));
    await provenance(ctx, args.conversationId, definition);
    const serialized = JSON.stringify(definition);
    const hash = fingerprint([args.expectedRevision, serialized]);
    if (row.lastRequest === args.requestId && row.lastHash === hash) return view(row);
    if (row.revision !== args.expectedRevision || running._creationTime < row.lastTurnAt) throw new Error("Revision conflict: read the current interactive answer and retry the intended edit.");
    await ctx.db.patch(row._id, {
      previous: JSON.stringify({ definition: row.definition, values: row.values }), definition: serialized,
      values: JSON.stringify(migrateValues(definition, view(row).definition, view(row).values)),
      revision: row.revision + 1, updatedAt: Date.now(), lastTurnAt: running._creationTime, lastRequest: args.requestId, lastHash: hash, revisions: row.revisions + 1,
    });
    return view((await ctx.db.get(row._id))!);
  },
});

/** All owner writes compare revisions inside the same SQLite transaction. */
export const save = mutation({
  args: { key: v.string(), conversationId: v.id("conversations"), id: v.id("interactiveAnswers"), expectedRevision: v.number(), requestId: v.string(), operation: v.union(v.literal("save"), v.literal("reset"), v.literal("undo")), values: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ ok: boolean; artifact: Artifact }> => {
    assertDashboardKey(args.key);
    requestId(args.requestId);
    const row = await artifact(ctx, args.conversationId, args.id);
    if (row.answeredAt) throw new Error("This answer has already been sent and cannot be edited.");
    const hash = fingerprint([args.expectedRevision, args.operation, args.values]);
    if (row.lastRequest === args.requestId && row.lastHash === hash) return { ok: true, artifact: view(row) };
    if (row.revision !== args.expectedRevision) {
      await ctx.db.patch(row._id, { conflicts: row.conflicts + 1 });
      return { ok: false, artifact: view(row) };
    }
    let definition = view(row).definition;
    let values: Values;
    if (args.operation === "undo") {
      if (!row.previous) throw new Error("There is no previous saved draft.");
      const previous: unknown = JSON.parse(row.previous);
      // Previous snapshots are server-written, but still parsed on the storage boundary.
      const snapshot = z.object({ definition: z.string(), values: z.string() }).parse(previous);
      definition = parseDefinition(JSON.parse(snapshot.definition));
      values = parseValues(definition, JSON.parse(snapshot.values));
    } else values = args.operation === "reset" ? migrateValues(definition) : parseValues(definition, JSON.parse(args.values ?? "{}"));
    await ctx.db.patch(row._id, {
      previous: JSON.stringify({ definition: row.definition, values: row.values }), definition: JSON.stringify(definition), values: JSON.stringify(values),
      revision: row.revision + 1, updatedAt: Date.now(), lastRequest: args.requestId, lastHash: hash, saves: row.saves + 1,
    });
    return { ok: true, artifact: view((await ctx.db.get(row._id))!) };
  },
});

/** Save the answer and enqueue its chat message in one transaction. */
export const answer = mutation({
  args: { key: v.string(), conversationId: v.id("conversations"), id: v.id("interactiveAnswers"), expectedRevision: v.number(), values: v.string() },
  handler: async (ctx, args): Promise<Artifact> => {
    assertDashboardKey(args.key);
    const row = await artifact(ctx, args.conversationId, args.id);
    const current = view(row);
    if (current.definition.view.kind !== "question") throw new Error("This interactive answer is not a question.");
    const values = parseValues(current.definition, JSON.parse(args.values));
    if (row.answeredAt) {
      if (current.definition.inputs.every((input) => current.values[input.id] === values[input.id])) return current;
      throw new Error("This question was already answered in another tab.");
    }
    if (row.revision !== args.expectedRevision) throw new Error("This question changed. Load the latest version before answering.");
    const lines = current.definition.inputs.flatMap((input) => {
      const value = values[input.id];
      return typeof value === "string" && !value.trim() ? [] : [`${input.label}: ${String(value)}`];
    });
    if (!lines.length) throw new Error("Choose an option or write an answer first.");
    await ctx.runMutation(api.dashboard.sendChat, {
      key: args.key, id: args.conversationId,
      text: `${INTERACTIVE_ANSWER}${row._id} -->\n${current.definition.title}\n${lines.join("\n")}`,
    });
    await ctx.db.patch(row._id, { values: JSON.stringify(values), answeredAt: Date.now(), revision: row.revision + 1, updatedAt: Date.now() });
    return view((await ctx.db.get(row._id))!);
  },
});

/** An explicit host form queues a draft request, never a sandbox tool call or account write. */
export const followup = mutation({
  args: { key: v.string(), conversationId: v.id("conversations"), id: v.id("interactiveAnswers"), expectedRevision: v.number(), requestId: v.string(), text: v.string() },
  handler: async (ctx, args): Promise<null> => {
    assertDashboardKey(args.key);
    requestId(args.requestId);
    const row = await artifact(ctx, args.conversationId, args.id);
    const hash = fingerprint(["followup", args.expectedRevision, args.text]);
    if (row.answeredAt) throw new Error("This question has already been answered. Continue in chat instead.");
    if (row.lastRequest === args.requestId && row.lastHash === hash) return null;
    if (row.revision !== args.expectedRevision) throw new Error("Revision conflict: save or load the latest draft before asking Perry.");
    if (!args.text.trim() || args.text.length > 1000) throw new Error("Follow-up must contain 1–1000 characters.");
    await ctx.runMutation(api.dashboard.sendChat, {
      key: args.key, id: args.conversationId,
      text: `${INTERACTIVE_DRAFT} ${row._id}, revision ${row.revision + 1}]\n${args.text}\nRevise this artifact using interactive_read and interactive_update. This requests a draft only; consequential account actions require separate approval.`,
    });
    await ctx.db.patch(row._id, { revision: row.revision + 1, lastRequest: args.requestId, lastHash: hash, updatedAt: Date.now() });
    return null;
  },
});

/** Aggregate counters only; no generated code, values, prompts, or credentials. */
export const report = mutation({
  args: { key: v.string(), conversationId: v.id("conversations"), id: v.id("interactiveAnswers"), event: v.union(v.literal("restored"), v.literal("error"), v.literal("ready")) },
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    const row = await artifact(ctx, args.conversationId, args.id);
    if (args.event === "ready") {
      if (!row.firstRenderedAt) await ctx.db.patch(row._id, { firstRenderedAt: Date.now() });
      return;
    }
    if (args.event === "restored" && !row.firstRenderedAt) return;
    const field = args.event === "restored" ? "restorations" : "errors";
    await ctx.db.patch(row._id, { [field]: Math.min(1_000_000, row[field] + 1) });
  },
});
