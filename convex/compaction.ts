import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { askAboutBrain } from "./approvals";
import { assertDashboardKey } from "./lib/auth";
import { appended, cleanTitle, editSection, noteHref } from "./lib/notes";
import { blockMarkdown, blocksOf, itemOf, journalTitle, removeLine, replaceLines, sameKey } from "./lib/pages";
import { timezoneOf } from "./jobs";
import { seenFrom } from "./memories";
import { isPinned, linesOf, linesProject, removePage, secretIn, setPinned, writePage, insertPage } from "./pages";

/**
 * Brain tidied with the owner's yes (issue #220, the owner's idea): Perry
 * proposes merging lines that say the same thing, condensing a long section,
 * rolling a past week of the journal up into a summary, or a fact inferred
 * from several lines; each proposal waits in Needs you and on the phone as a
 * before and after, to approve, edit or decline. Nothing in Brain changes
 * until the owner says yes.
 *
 * Applied, a merge or a condensation takes its lines out of their page and
 * puts the new ones in their place; the old lines stay, as rows superseded by
 * the new ones and marked with the proposal (compactedBy, compactedFrom: their
 * page, section and place), so they are history, not lost. A rollup adds a
 * page of its own (the week, kind journal, rollup) and leaves the days as
 * they are. Undo puts it all back as it was, the old lines with their ids.
 *
 * Rearranging Brain (#230) is proposed the same way: move lines to a better
 * page, split some off to a page of their own, merge one page into another
 * (the merged page keeps a link there), or make a topic page that gathers
 * what is said across pages. Lines move as the rows they are (ids, who wrote
 * them, from which chat, when), never into a page another set of chats
 * reads; Undo moves them back and takes away the page it made.
 *
 * Proposals come from the weekly Brain review (jobs.ts): the duplicates found
 * here by their words (review), and what Perry writes itself with brain_review
 * and brain_propose. One with the same lines is never proposed twice while it
 * waits, nor again for 90 days once declined.
 */

type Proposal = Doc<"brainProposals">;
type Line = Doc<"memories">;
const DAY_MS = 86_400_000;
const DECLINED_FOR_MS = 90 * DAY_MS;
export const vProposalKind = v.union(
  v.literal("merge"), v.literal("condense"), v.literal("rollup"), v.literal("infer"),
  v.literal("move"), v.literal("split"), v.literal("mergePages"), v.literal("topic"),
);
type Kind = Proposal["kind"];
const VERB: Record<"merge" | "condense" | "rollup" | "infer", string> = { merge: "Merge", condense: "Condense", rollup: "Roll up", infer: "Add what follows from" };
/** Kinds that move lines between pages as the rows they are. */
const MOVES: readonly Kind[] = ["move", "split", "mergePages"];

const keyOf = (kind: Kind, ids: string[], to = "") => `${kind}:${[...ids].sort().join(",")}${to ? `>${to}` : ""}`;
const plural = (count: number) => `${count} ${count === 1 ? "line" : "lines"}`;

/** What the owner is asked: one line saying what and where, then the lines now and the lines after. */
function describe(proposal: Pick<Proposal, "kind" | "before" | "after" | "summary" | "title" | "targetSection">, where: string, target?: string): { title: string; detail: string } {
  const count = proposal.before.length;
  const list = (lines: string[]) => lines.map((line) => `- ${line.replace(/\s+/g, " ").slice(0, 300)}`).join("\n");
  const to = `${target ?? ""}${proposal.targetSection ? ` › ${proposal.targetSection}` : ""}`;
  switch (proposal.kind) {
    case "move": return { title: `Move ${plural(count)} from ${where} to ${to}`, detail: [proposal.summary, `Lines:\n${list(proposal.before.map((line) => line.text))}`].filter(Boolean).join("\n\n") };
    case "split": return { title: `Move ${plural(count)} from ${where} to a new page, ${proposal.title}`, detail: [proposal.summary, `Lines:\n${list(proposal.before.map((line) => line.text))}`].filter(Boolean).join("\n\n") };
    case "mergePages": return { title: `Merge the page ${where} into ${to}`, detail: [proposal.summary, count ? `Its lines:\n${list(proposal.before.map((line) => line.text))}` : ""].filter(Boolean).join("\n\n") };
    case "topic": return { title: `Make a topic page, ${proposal.title}, from ${plural(count)}`, detail: [proposal.summary, `From:\n${list(proposal.before.map((line) => line.text))}`, `It says:\n${list(proposal.after)}`].filter(Boolean).join("\n\n") };
    default: {
      const title = `${VERB[proposal.kind]} ${plural(count)} in ${where}`;
      const detail = [
        proposal.summary,
        `${proposal.kind === "rollup" || proposal.kind === "infer" ? "From" : "Now"}:\n${list(proposal.before.map((line) => line.text))}`,
        `${proposal.kind === "rollup" ? "Summary" : proposal.kind === "infer" ? "Adds" : "After"}:\n${list(proposal.after)}`,
      ].filter(Boolean).join("\n\n");
      return { title, detail };
    }
  }
}

/** Who reads a line, or a page's lines: a project's chats, one chat, or every chat of the owner's. */
const scopeOfLine = (line: Pick<Line, "projectId" | "conversationId">) => `${line.projectId ?? ""}|${line.conversationId ?? ""}`;
const scopeOfPage = (page: Doc<"notes">) => `${linesProject(page) ?? ""}|${page.conversationId ?? ""}`;
/** Pages whose lines are a day's or a few words Perry rewrites whole: never where lines are moved to, or merged. */
const FIXED = (page: Doc<"notes">) => page.kind === "about" || page.kind === "journal" || page.kind === "journey" || Boolean(page.lately) || Boolean(page.rollup) || Boolean(page.mergedInto);

/**
 * Lines moved to another page as the rows they are: each taken out of its
 * page's words, as it was written there, and put in the target's, under
 * `sectionOf` it, and kept by both saves (pages.syncLines). Where each stood
 * before is returned, for Undo.
 */
async function moveRows(ctx: MutationCtx, lines: Line[], target: Doc<"notes">, sectionOf: (line: Line) => string | undefined, head?: string): Promise<Array<{ id: Id<"memories">; pageId: Id<"notes">; section?: string }>> {
  const moved: Array<{ id: Id<"memories">; pageId: Id<"notes">; section?: string }> = [];
  const sources = new Map<string, { page: Doc<"notes">; content: string }>();
  let content = head ?? target.content;
  const spare = new Set<string>();
  for (const line of lines) {
    if (!line.pageId) continue;
    if (!sources.has(line.pageId)) {
      const page = await ctx.db.get(line.pageId);
      if (!page) continue;
      sources.set(line.pageId, { page, content: page.content });
    }
    const source = sources.get(line.pageId)!;
    const block = blocksOf(source.content).find((item) => sameKey(item.text) === sameKey(line.text));
    const words = block ? blockMarkdown(source.content, block) : itemOf(line.text);
    if (block) source.content = removeLine(source.content, line.text) ?? source.content;
    const section = sectionOf(line);
    const placed = section ? editSection(content, section, words, "append") : null;
    content = placed && "content" in placed ? placed.content : appended(content, words);
    moved.push({ id: line._id, pageId: line.pageId, ...(line.section ? { section: line.section } : {}) });
    await ctx.db.patch(line._id, { pageId: target._id, order: Number.MAX_SAFE_INTEGER, section });
    spare.add(line._id);
  }
  await writePage(ctx, (await ctx.db.get(target._id))!, { content }, { by: "owner" }, { spare });
  for (const { page, content: left } of sources.values()) {
    if (page._id !== target._id) await writePage(ctx, (await ctx.db.get(page._id))!, { content: left.trim() ? `${left.replace(/\n{3,}/g, "\n\n").trim()}\n` : "" }, { by: "owner" });
  }
  return moved;
}

/** For a rearrangement: the page lines go to, or why it cannot be done. */
async function checkRearrange(ctx: MutationCtx, input: { kind: Kind; targetPageId?: Id<"notes">; title?: string }, page: Doc<"notes">): Promise<{ target?: Doc<"notes">; error?: string }> {
  if (input.kind === "split" || input.kind === "topic") return input.title?.trim() ? {} : { error: "Name the new page (title)." };
  if (input.kind !== "move" && input.kind !== "mergePages") return {};
  const target = input.targetPageId ? await ctx.db.get(input.targetPageId) : null;
  if (!target) return { error: "Name the page the lines go to (to)." };
  if (target._id === page._id) return { error: "That is the page they are on." };
  if (FIXED(target)) return { error: `Lines are not moved into "${target.title}".` };
  if (input.kind === "mergePages") {
    if (FIXED(page) || page.kind === "remember" || page.kind === "chat") return { error: `"${page.title}" cannot be merged into another page.` };
    if ((page.kind ?? "page") !== (target.kind ?? "page")) return { error: "Only two people's pages, or two of the owner's own pages, can be merged." };
    if (scopeOfPage(page) !== scopeOfPage(target)) return { error: "Those pages are read in different chats: they cannot be merged." };
  }
  return { target };
}

/**
 * A proposal, asked of the owner: the lines it would change, each current and
 * on the page named (a rollup's from that week's journal), and what would
 * stand instead. Refused when its lines moved on, when the same was proposed
 * and is waiting or was declined lately, or when the new words hold a secret.
 */
export async function propose(ctx: MutationCtx, input: {
  kind: Kind; pageId: Id<"notes">; section?: string; before: string[]; after: string[]; summary: string; by: Proposal["by"];
  targetPageId?: Id<"notes">; targetSection?: string; title?: string;
}): Promise<{ id?: Id<"brainProposals">; error?: string }> {
  const page = await ctx.db.get(input.pageId);
  if (!page) return { error: "No such page." };
  const after = input.after.map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!after.length && !MOVES.includes(input.kind)) return { error: "Say what the lines become." };
  const rearranging = await checkRearrange(ctx, input, page);
  if (rearranging.error) return { error: rearranging.error };
  const target = rearranging.target;
  // Merging a page takes all of its lines.
  if (input.kind === "mergePages") input = { ...input, before: (await linesOf(ctx, page._id)).map((line) => line._id) };
  const before: Array<{ id: Id<"memories">; text: string }> = [];
  let firstScope: string | undefined;
  for (const raw of [...new Set(input.before)]) {
    const id = ctx.db.normalizeId("memories", raw);
    const line = id ? await ctx.db.get(id) : null;
    if (!line || line.supersededBy) return { error: `Line ${raw} is not a current line.` };
    if (input.kind !== "rollup" && input.kind !== "topic" && line.pageId !== page._id) return { error: `Line ${raw} is not on "${page.title}".` };
    if (MOVES.includes(input.kind) && target && scopeOfLine(line) !== scopeOfPage(target)) return { error: `Line ${raw} is read in other chats than "${target.title}" is: it cannot move there.` };
    if ((input.kind === "split" || input.kind === "topic") && (line.conversationId || scopeOfLine(line) !== (firstScope ??= scopeOfLine(line)))) return { error: "Those lines are read in different chats: they cannot go on one page." };
    if (input.kind === "rollup" && (await ctx.db.get(line.pageId!))?.kind !== "journal") return { error: `Line ${raw} is not in the journal.` };
    before.push({ id: line._id, text: line.text });
  }
  if (before.length < (input.kind === "merge" || input.kind === "topic" ? 2 : input.kind === "mergePages" ? 0 : 1)) {
    return { error: input.kind === "merge" ? "A merge needs two lines or more." : input.kind === "topic" ? "A topic page gathers two lines or more." : "Name the lines it comes from." };
  }
  const secret = await secretIn(ctx, [...after, input.title ?? ""].join("\n"));
  if (secret) return { error: secret };
  const key = keyOf(input.kind, input.kind === "mergePages" ? [page._id] : before.map((line) => line.id), target?._id ?? input.title?.trim().toLocaleLowerCase());
  for (const other of await ctx.db.query("brainProposals").withIndex("by_key", (q) => q.eq("key", key)).collect()) {
    if (other.status === "pending") return { error: "That is already waiting for the owner." };
    if (other.status === "declined" && Date.now() - (other.decidedAt ?? 0) < DECLINED_FOR_MS) return { error: "The owner declined that lately." };
  }
  const proposal = {
    kind: input.kind, pageId: page._id, ...(input.section ? { section: input.section } : {}), summary: input.summary.trim().slice(0, 300), before, after, key, status: "pending" as const, by: input.by, createdAt: Date.now(),
    ...(target ? { targetPageId: target._id } : {}), ...(input.targetSection?.trim() ? { targetSection: input.targetSection.trim() } : {}), ...(input.title?.trim() ? { title: cleanTitle(input.title) } : {}),
  };
  const id = await ctx.db.insert("brainProposals", proposal);
  const where = input.kind === "rollup" ? `the journal, ${input.section ?? page.title}` : input.kind === "topic" ? "Brain" : `${page.title}${input.section ? ` › ${input.section}` : ""}`;
  const approvalId = await askAboutBrain(ctx, { proposalId: id, ...describe(proposal, where, target?.title) });
  if (approvalId) await ctx.db.patch(id, { approvalId });
  return { id };
}

/** The owner's answer, from wherever they gave it (approvals.settleRow): applied, or left as it was. */
export const decided = internalMutation({
  args: { id: v.id("brainProposals"), approved: v.boolean(), expired: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const proposal = await ctx.db.get(args.id);
    if (!proposal || proposal.status !== "pending") return null;
    if (!args.approved) {
      await ctx.db.patch(proposal._id, { status: args.expired ? "expired" : "declined", decidedAt: Date.now() });
      return null;
    }
    await apply(ctx, proposal);
    return null;
  },
});

/** The owner edited what the lines become before approving (the dashboard). */
export async function editProposal(ctx: MutationCtx, id: Id<"brainProposals">, after: string[]): Promise<boolean> {
  const proposal = await ctx.db.get(id);
  const lines = after.map((text) => text.replace(/^\s*[-*]\s+/, "").replace(/\s+/g, " ").trim()).filter(Boolean);
  // Lines that move keep their words: there is nothing to edit.
  if (!proposal || proposal.status !== "pending" || !lines.length || MOVES.includes(proposal.kind)) return false;
  if (await secretIn(ctx, lines.join("\n"))) return false;
  await ctx.db.patch(id, { after: lines, edited: true });
  return true;
}

async function apply(ctx: MutationCtx, proposal: Proposal) {
  const now = Date.now();
  // What it changes must be as it was when the owner read it.
  const lines: Line[] = [];
  for (const item of proposal.before) {
    const line = await ctx.db.get(item.id);
    if (!line || line.supersededBy || line.text !== item.text) {
      await ctx.db.patch(proposal._id, { status: "stale", decidedAt: now });
      return;
    }
    lines.push(line);
  }
  if (MOVES.includes(proposal.kind) && lines.some((line) => line.pageId !== proposal.pageId)) {
    await ctx.db.patch(proposal._id, { status: "stale", decidedAt: now });
    return;
  }
  if (MOVES.includes(proposal.kind) || proposal.kind === "topic") {
    await rearrange(ctx, proposal, lines, now);
    return;
  }
  if (proposal.kind === "rollup") {
    const days = lines.map((line) => line.day ?? "").filter(Boolean).sort();
    const first = days[0] ?? new Date(lines[0].createdAt).toISOString().slice(0, 10);
    const content = `${proposal.after.map((text) => itemOf(text)).join("\n")}\n\nFrom ${days.length ? `${journalTitle(first)} to ${journalTitle(days.at(-1)!)}` : "the journal"}.\n`;
    const pageId = await insertPage(ctx, { title: proposal.section ?? `Week of ${journalTitle(first)}`, content, author: { by: "job" }, kind: "journal", day: first });
    await ctx.db.patch(pageId, { rollup: true });
    const added = (await linesOf(ctx, pageId)).map((line) => line._id);
    for (const id of added) await ctx.db.patch(id, { basedOn: lines.map((line) => line._id), relation: { to: lines[0]._id, how: "derives" }, type: "episode" });
    await ctx.db.patch(proposal._id, { status: "applied", decidedAt: now, appliedAt: now, added, rollupPageId: pageId });
    return;
  }
  const page = await ctx.db.get(proposal.pageId);
  if (!page) {
    await ctx.db.patch(proposal._id, { status: "stale", decidedAt: now });
    return;
  }
  // An inferred fact is added beside what it comes from; the rest replace their lines where the first one stood.
  const content = proposal.kind === "infer"
    ? (() => {
      const placed = proposal.section ? editSection(page.content, proposal.section, proposal.after.map(itemOf).join("\n"), "append") : null;
      return placed && "content" in placed ? placed.content : appended(page.content, proposal.after.map(itemOf).join("\n"));
    })()
    : replaceLines(page.content, lines.map((line) => line.text), proposal.after);
  if (content === null) {
    await ctx.db.patch(proposal._id, { status: "stale", decidedAt: now });
    return;
  }
  // The old lines leave the page as rows of their own first, so the save cannot take one for the new words.
  if (proposal.kind !== "infer") {
    for (const line of lines) {
      await ctx.db.patch(line._id, {
        pageId: undefined, order: undefined, compactedBy: proposal._id,
        compactedFrom: { pageId: page._id, ...(line.section ? { section: line.section } : {}), order: line.order ?? 0 },
        embedding: undefined, embeddedWith: undefined,
      });
    }
  }
  const made = await writePage(ctx, (await ctx.db.get(page._id))!, { content }, { by: "owner" });
  const wanted = new Set(proposal.after.map(sameKey));
  const added = [...made].filter(([key]) => wanted.has(key)).map(([, id]) => id);
  for (const id of added) await ctx.db.patch(id, { basedOn: lines.map((line) => line._id), relation: { to: lines[0]._id, how: proposal.kind === "infer" ? "derives" as const : "updates" as const } });
  if (proposal.kind !== "infer") for (const line of lines) await ctx.db.patch(line._id, { supersededBy: added[0] ?? line._id });
  await ctx.db.patch(proposal._id, { status: "applied", decidedAt: now, appliedAt: now, added });
}

/** Apply a rearrangement the owner approved: move, split, merge a page into another, or make a topic page. */
async function rearrange(ctx: MutationCtx, proposal: Proposal, lines: Line[], now: number) {
  const page = await ctx.db.get(proposal.pageId);
  const target = proposal.targetPageId ? await ctx.db.get(proposal.targetPageId) : null;
  const stale = async () => { await ctx.db.patch(proposal._id, { status: "stale", decidedAt: now }); };
  if (!page || ((proposal.kind === "move" || proposal.kind === "mergePages") && (!target || FIXED(target)))) return await stale();
  if (proposal.kind === "move") {
    const moved = await moveRows(ctx, lines, target!, () => proposal.targetSection);
    await ctx.db.patch(proposal._id, { status: "applied", decidedAt: now, appliedAt: now, moved });
    return;
  }
  if (proposal.kind === "mergePages") {
    // Every line it has now, not only those it had when asked: a page merged is left with none of its own.
    const all = (await linesOf(ctx, page._id)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const mergedContent = page.content;
    const moved = await moveRows(ctx, all, target!, (line) => line.section);
    await writePage(ctx, (await ctx.db.get(page._id))!, { content: `Merged into [${target!.title.replace(/[[\]]/g, "")}](${noteHref(target!._id)}).\n` }, { by: "owner" });
    await ctx.db.patch(page._id, { mergedInto: target!._id });
    await ctx.db.patch(proposal._id, { status: "applied", decidedAt: now, appliedAt: now, moved, mergedContent });
    return;
  }
  const title = proposal.title ?? "Untitled";
  const projectId = lines.find((line) => line.projectId)?.projectId;
  if (proposal.kind === "split") {
    const made = await insertPage(ctx, { title, content: "", author: { by: "owner" }, ...(projectId ? { projectId } : {}) });
    // Pinned where they were, so what every chat is sent keeps them.
    const pinned = isPinned(page) || lines.some((line) => line.section && page.pinnedSections?.includes(line.section));
    if (pinned) await setPinned(ctx, (await ctx.db.get(made))!, true);
    const moved = await moveRows(ctx, lines, (await ctx.db.get(made))!, (line) => line.section);
    // Where they were, a link to where they are now.
    const current = (await ctx.db.get(page._id))!;
    const link = `See [${title.replace(/[[\]]/g, "")}](${noteHref(made)}).`;
    const section = lines[0].section;
    const placed = section ? editSection(current.content, section, link, "append") : null;
    await writePage(ctx, current, { content: placed && "content" in placed ? placed.content : appended(current.content, link) }, { by: "owner" });
    await ctx.db.patch(proposal._id, { status: "applied", decidedAt: now, appliedAt: now, moved, madePageId: made });
    return;
  }
  // A topic page: what the lines say together, and a link to each page they are on; the lines stay where they are.
  const homes: Array<Doc<"notes">> = [];
  for (const line of lines) if (line.pageId && !homes.some((home) => home._id === line.pageId)) { const home = await ctx.db.get(line.pageId); if (home) homes.push(home); }
  const content = `${proposal.after.map(itemOf).join("\n")}\n\n## Related\n\n${homes.map((home) => `- [${home.title.replace(/[[\]]/g, "")}](${noteHref(home._id)})`).join("\n")}\n`;
  const made = await insertPage(ctx, { title, content, author: { by: "owner" }, ...(projectId ? { projectId } : {}) });
  const wanted = new Set(proposal.after.map(sameKey));
  const added = (await linesOf(ctx, made)).filter((line) => wanted.has(sameKey(line.text))).map((line) => line._id);
  for (const id of added) await ctx.db.patch(id, { basedOn: lines.map((line) => line._id), relation: { to: lines[0]._id, how: "derives" } });
  await ctx.db.patch(proposal._id, { status: "applied", decidedAt: now, appliedAt: now, added, madePageId: made });
}

/** Undo a rearrangement: the lines back on the pages and in the sections they were on, and the page it made gone if nothing else is on it. */
async function unarrange(ctx: MutationCtx, proposal: Proposal): Promise<{ error?: string }> {
  if (proposal.kind === "topic") {
    if (proposal.madePageId) await removePage(ctx, proposal.madePageId);
    return {};
  }
  const back = new Map<string, Line[]>();
  const sectionOf = new Map<string, string | undefined>();
  for (const item of proposal.moved ?? []) {
    const line = await ctx.db.get(item.id);
    if (!line || line.supersededBy || !line.pageId) continue;
    if (!await ctx.db.get(item.pageId)) return { error: "A page the lines came from was deleted." };
    sectionOf.set(line._id, item.section);
    back.set(item.pageId, [...(back.get(item.pageId) ?? []), line]);
  }
  if (proposal.kind === "mergePages") {
    const page = await ctx.db.get(proposal.pageId);
    if (!page) return { error: "The merged page was deleted." };
    await ctx.db.patch(page._id, { mergedInto: undefined });
    // Its words as they were, with its lines on it again: the save keeps them as the rows they are.
    await moveRows(ctx, back.get(page._id) ?? [], (await ctx.db.get(page._id))!, (line) => sectionOf.get(line._id), "");
    await writePage(ctx, (await ctx.db.get(page._id))!, { content: proposal.mergedContent ?? "" }, { by: "owner" }, { spare: new Set((back.get(page._id) ?? []).map((line) => line._id)) });
    return {};
  }
  for (const [pageId, lines] of back) await moveRows(ctx, lines, (await ctx.db.get(pageId as Id<"notes">))!, (line) => sectionOf.get(line._id));
  if (proposal.kind === "split") {
    const source = await ctx.db.get(proposal.pageId);
    if (source && proposal.madePageId) {
      const link = blocksOf(source.content).find((block) => block.text.includes(noteHref(proposal.madePageId!)));
      if (link) await writePage(ctx, source, { content: removeLine(source.content, link.text) ?? source.content }, { by: "owner" });
    }
    if (proposal.madePageId && !(await linesOf(ctx, proposal.madePageId)).length) await removePage(ctx, proposal.madePageId);
  }
  return {};
}

/**
 * Undo a change the owner approved: a rollup's page goes; merged or condensed
 * lines come back to their page and section, as the rows they were, and the
 * lines that replaced them go. What the owner wrote on the page since stays.
 */
export const undo = mutation({
  args: { key: v.string(), id: v.id("brainProposals") },
  returns: v.object({ undone: v.boolean(), error: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    assertDashboardKey(args.key);
    return await undoProposal(ctx, args.id);
  },
});

export async function undoProposal(ctx: MutationCtx, id: Id<"brainProposals">): Promise<{ undone: boolean; error?: string }> {
  const proposal = await ctx.db.get(id);
  if (!proposal || proposal.status !== "applied") return { undone: false, error: "There is nothing to undo." };
  if (MOVES.includes(proposal.kind) || proposal.kind === "topic") {
    const done = await unarrange(ctx, proposal);
    if (done.error) return { undone: false, error: done.error };
    await ctx.db.patch(id, { status: "undone", undoneAt: Date.now() });
    return { undone: true };
  }
  if (proposal.kind === "rollup") {
    if (proposal.rollupPageId) await removePage(ctx, proposal.rollupPageId);
    await ctx.db.patch(id, { status: "undone", undoneAt: Date.now() });
    return { undone: true };
  }
  const page = await ctx.db.get(proposal.pageId);
  if (!page) return { undone: false, error: "The page was deleted." };
  let content = page.content;
  // The lines it added go, as far as they are still on the page in its words.
  for (const added of proposal.added ?? []) {
    const line = await ctx.db.get(added);
    if (line?.pageId === page._id) {
      const blocks = blocksOf(content);
      const block = blocks.find((item) => sameKey(item.text) === sameKey(line.text));
      if (block) content = content.replace(/\r\n?/g, "\n").split("\n").filter((_, at) => at < block.start || at > block.end).join("\n");
    }
  }
  if (proposal.kind !== "infer") {
    // The old ones come back where they were, as the same rows: on the page before the save, so it keeps them.
    for (const item of [...proposal.before].reverse()) {
      const line = await ctx.db.get(item.id);
      if (!line) continue;
      const from = line.compactedFrom;
      const placed = from?.section ? editSection(content, from.section, itemOf(line.text), "append") : null;
      content = placed && "content" in placed ? placed.content : appended(content, itemOf(line.text));
      await ctx.db.patch(line._id, { pageId: page._id, order: Number.MAX_SAFE_INTEGER, ...(from?.section ? { section: from.section } : {}), supersededBy: undefined, compactedBy: undefined, compactedFrom: undefined });
    }
  }
  await writePage(ctx, (await ctx.db.get(page._id))!, { content: `${content.replace(/\n{3,}/g, "\n\n").trim()}\n` }, { by: "owner" });
  for (const added of proposal.added ?? []) {
    const line = await ctx.db.get(added);
    if (line && line.pageId === page._id && !content.includes(line.text)) await ctx.db.delete(added);
  }
  await ctx.db.patch(id, { status: "undone", undoneAt: Date.now() });
  await ctx.scheduler.runAfter(0, internal.memories.embedMissing, {});
  return { undone: true };
}

// --- Finding what to propose ---------------------------------------------------------------------

const wordsOf = (text: string) => new Set(text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1));
function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared || 1);
}

/** Pages a review looks over: Things to remember (each project's too), people, what chats kept. */
async function reviewed(ctx: QueryCtx): Promise<Doc<"notes">[]> {
  const pages: Doc<"notes">[] = [];
  for (const kind of ["remember", "person", "chat"] as const) pages.push(...(await ctx.db.query("notes").withIndex("by_kind", (q) => q.eq("kind", kind)).collect()).filter((page) => page.kind === kind));
  return pages;
}

/** Lines of one section that say the same thing in nearly the same words: what a merge would join. */
function duplicates(lines: Line[]): Line[][] {
  const groups: Line[][] = [];
  const words = new Map(lines.map((line) => [line._id, wordsOf(line.text)]));
  const taken = new Set<string>();
  for (const line of lines) {
    if (taken.has(line._id) || (words.get(line._id)?.size ?? 0) < 3) continue;
    const group = [line, ...lines.filter((other) => other._id !== line._id && !taken.has(other._id) && (other.section ?? "") === (line.section ?? "") && jaccard(words.get(line._id)!, words.get(other._id)!) >= 0.85)];
    if (group.length < 2) continue;
    for (const item of group) taken.add(item._id);
    groups.push(group);
  }
  return groups;
}

/** A week of the journal not rolled up yet, from at least five weeks ago, the oldest first. */
async function weeksToRollUp(ctx: QueryCtx, most: number): Promise<Array<{ week: string; title: string; lines: Array<{ id: string; day?: string; text: string }> }>> {
  const timezone = await timezoneOf(ctx);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: timezone });
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - 35 * DAY_MS).toISOString().slice(0, 10);
  const pages = (await ctx.db.query("notes").withIndex("by_kind", (q) => q.eq("kind", "journal").lt("day", cutoff)).collect()).filter((page) => page.kind === "journal" && !page.projectId);
  const rolled = new Set(pages.filter((page) => page.rollup).map((page) => page.day));
  const weeks = new Map<string, Doc<"notes">[]>();
  for (const page of pages) {
    if (page.rollup || !page.day) continue;
    const date = new Date(`${page.day}T00:00:00Z`);
    const monday = new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
    if (rolled.has(monday)) continue;
    weeks.set(monday, [...(weeks.get(monday) ?? []), page]);
  }
  const out: Array<{ week: string; title: string; lines: Array<{ id: string; day?: string; text: string }> }> = [];
  for (const [week, days] of [...weeks].sort((a, b) => a[0].localeCompare(b[0])).slice(0, most)) {
    const lines: Array<{ id: string; day?: string; text: string }> = [];
    for (const page of days.sort((a, b) => (a.day ?? "").localeCompare(b.day ?? ""))) for (const line of await linesOf(ctx, page._id)) lines.push({ id: line._id, ...(line.day ? { day: line.day } : {}), text: line.text });
    if (lines.length) out.push({ week, title: `Week of ${journalTitle(week)}`, lines: lines.slice(0, 400) });
  }
  return out;
}

/**
 * The weekly review's own part, no model needed: lines of a section that say
 * the same in nearly the same words become merge proposals, keeping the
 * fullest, most recent wording. Run by the Brain review job and when a page
 * grows past a few hundred lines (pages.syncLines). Returns how many it proposed.
 */
export const review = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    let made = 0;
    for (const page of await reviewed(ctx)) {
      for (const group of duplicates(await linesOf(ctx, page._id))) {
        const best = [...group].sort((a, b) => b.text.length - a.text.length || Math.max(b.createdAt, b.editedAt ?? 0) - Math.max(a.createdAt, a.editedAt ?? 0))[0];
        const done = await propose(ctx, { kind: "merge", pageId: page._id, ...(best.section ? { section: best.section } : {}), before: group.map((line) => line._id), after: [best.text], summary: "These say the same thing; one line keeps it.", by: "review" });
        if (done.id) made++;
        if (made >= 20) return made;
      }
    }
    const install = await ctx.db.query("installation").first();
    if (install) await ctx.db.patch(install._id, { brainReviewedAt: Date.now() });
    return made;
  },
});

/** A big page was saved: the review's own part runs, unless it ran in the last day. */
export const reviewIfDue = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const install = await ctx.db.query("installation").first();
    if (install?.brainReviewedAt && Date.now() - install.brainReviewedAt < DAY_MS) return null;
    if (install) await ctx.db.patch(install._id, { brainReviewedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.compaction.review, {});
    return null;
  },
});

/**
 * Pages that may be about the same person or thing, for Perry to read and perhaps propose merging: two people's
 * pages, or two of the owner's own, read in the same chats, where one title is the other's words and more ("Juhi",
 * "Juhi Sharma") or both are the same but for case and spacing. At most ten pairs.
 */
async function samePages(ctx: QueryCtx): Promise<Array<{ a: { id: string; title: string }; b: { id: string; title: string } }>> {
  const words = (title: string) => title.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const pairs: Array<{ a: { id: string; title: string }; b: { id: string; title: string } }> = [];
  const people = (await ctx.db.query("notes").withIndex("by_kind", (q) => q.eq("kind", "person")).collect()).filter((page) => page.kind === "person" && !page.mergedInto);
  const own = (await ctx.db.query("notes").withIndex("by_kind", (q) => q.eq("kind", undefined)).collect()).filter((page) => !page.kind && !page.mergedInto && !page.lately);
  for (const group of [people, own]) {
    for (let i = 0; i < group.length && pairs.length < 10; i++) {
      for (let j = i + 1; j < group.length && pairs.length < 10; j++) {
        const [a, b] = [group[i], group[j]];
        if (scopeOfPage(a) !== scopeOfPage(b)) continue;
        const [x, y] = [words(a.title), words(b.title)].sort((m, n) => m.length - n.length);
        if (!x.length || !x.every((word, at) => y[at] === word)) continue;
        pairs.push({ a: { id: a._id, title: a.title }, b: { id: b._id, title: b.title } });
      }
    }
  }
  return pairs;
}

/** Perry's brain_review: what is worth proposing, for it to write the new words of. */
export const forReview = internalQuery({
  args: {},
  handler: async (ctx): Promise<{
    sections: Array<{ page: string; pageId: string; section?: string; lines: number }>; weeks: Array<{ week: string; title: string; lines: Array<{ id: string; day?: string; text: string }> }>;
    samePages: Array<{ a: { id: string; title: string }; b: { id: string; title: string } }>; waiting: number;
  }> => {
    const sections: Array<{ page: string; pageId: string; section?: string; lines: number }> = [];
    for (const page of await reviewed(ctx)) {
      const counts = new Map<string, number>();
      for (const line of await linesOf(ctx, page._id)) counts.set(line.section ?? "", (counts.get(line.section ?? "") ?? 0) + 1);
      for (const [section, lines] of counts) if (lines >= 150) sections.push({ page: page.title, pageId: page._id, ...(section ? { section } : {}), lines });
    }
    const waiting = (await ctx.db.query("brainProposals").withIndex("by_status", (q) => q.eq("status", "pending")).collect()).length;
    return { sections: sections.sort((a, b) => b.lines - a.lines).slice(0, 10), weeks: await weeksToRollUp(ctx, 2), samePages: await samePages(ctx), waiting };
  },
});

/** Perry's brain_propose. */
export const proposeForAgent = internalMutation({
  args: {
    chat: v.optional(v.id("conversations")), kind: vProposalKind, page: v.optional(v.string()), section: v.optional(v.string()),
    replaces: v.array(v.string()), with: v.array(v.string()), why: v.string(),
    to: v.optional(v.string()), toSection: v.optional(v.string()), title: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ proposed?: string; error?: string }> => {
    const chat = args.chat ? await ctx.db.get(args.chat) : null;
    if (chat?.contactId) return { error: "Not from a chat with someone else." };
    let pageId: Id<"notes"> | null = null;
    const named = async (raw: string) => {
      const id = ctx.db.normalizeId("notes", raw.trim());
      const found = id ? await ctx.db.get(id) : (await ctx.db.query("notes").withIndex("by_title", (q) => q.eq("title", raw.trim())).collect()).find((page) => !page.projectId || page.projectId === chat?.projectId) ?? null;
      return found && (!found.projectId || found.projectId === chat?.projectId || !chat?.projectId) ? found : null;
    };
    const to = args.to?.trim() ? await named(args.to) : null;
    if (args.to?.trim() && !to) return { error: `No page "${args.to}".` };
    // Only lines this chat may see (a project's chat sees its project's and everyone's).
    const seen = await seenFrom(ctx, chat?._id);
    for (const raw of args.replaces) {
      const id = ctx.db.normalizeId("memories", raw);
      const line = id ? await ctx.db.get(id) : null;
      if (line && !seen(line)) return { error: `Line ${raw} is not one this chat may see.` };
    }
    if (args.kind === "rollup" || args.kind === "topic" || (!args.page?.trim() && args.kind !== "mergePages")) {
      const first = args.replaces.map((raw) => ctx.db.normalizeId("memories", raw)).find(Boolean);
      pageId = first ? (await ctx.db.get(first))?.pageId ?? null : null;
    } else {
      const raw = args.page?.trim() ?? "";
      const id = ctx.db.normalizeId("notes", raw);
      pageId = id ?? (await ctx.db.query("notes").withIndex("by_title", (q) => q.eq("title", raw)).first())?._id ?? null;
    }
    if (!pageId) return { error: "Name the page (or for a rollup, the journal lines)." };
    const done = await propose(ctx, {
      kind: args.kind, pageId, ...(args.section ? { section: args.section } : {}), before: args.replaces, after: args.with, summary: args.why, by: "assistant",
      ...(to ? { targetPageId: to._id } : {}), ...(args.toSection?.trim() ? { targetSection: args.toSection } : {}), ...(args.title?.trim() ? { title: args.title } : {}),
    });
    return done.id ? { proposed: `Waiting for the owner's OK (${done.id}).` } : { error: done.error };
  },
});

// --- The dashboard ------------------------------------------------------------------------------

export type ProposalView = {
  id: Id<"brainProposals">; kind: Kind; status: Proposal["status"]; page?: { id: Id<"notes">; title: string }; section?: string;
  summary: string; before: string[]; after: string[]; edited?: boolean; createdAt: number; appliedAt?: number; approvalId?: Id<"approvals">;
  /** Rearranging: where the lines went, or the page made. */
  target?: { id: Id<"notes">; title: string }; title?: string;
  /** What it did, in a few words, for Brain's list. */
  headline: string;
};

/** What a change did, in a few words: "Moved 3 lines to Goa trip". */
function headline(row: Proposal, page: { title: string } | null, target: { title: string } | null): string {
  const count = plural(row.before.length);
  switch (row.kind) {
    case "move": return `Moved ${count} to ${target?.title ?? "another page"}`;
    case "split": return `Moved ${count} to a new page, ${row.title ?? ""}`;
    case "mergePages": return `Merged ${page?.title ?? "a page"} into ${target?.title ?? "another page"}`;
    case "topic": return `Made ${row.title ?? "a topic page"}`;
    default: return `${row.after[0] ?? ""}${row.after.length > 1 ? ` (+${row.after.length - 1})` : ""}`;
  }
}

/** Changes to Brain: those waiting for the owner, and the last ones applied, which can be undone. */
export const list = query({
  args: { key: v.string() },
  handler: async (ctx, args): Promise<ProposalView[]> => {
    assertDashboardKey(args.key);
    const rows = [
      ...await ctx.db.query("brainProposals").withIndex("by_status", (q) => q.eq("status", "pending")).order("desc").take(50),
      ...await ctx.db.query("brainProposals").withIndex("by_status", (q) => q.eq("status", "applied")).order("desc").take(20),
    ];
    const views: ProposalView[] = [];
    for (const row of rows) {
      const page = await ctx.db.get(row.rollupPageId ?? row.pageId);
      const target = await ctx.db.get(row.targetPageId ?? row.madePageId ?? row.pageId);
      const to = row.targetPageId || row.madePageId ? target : null;
      views.push({
        headline: headline(row, page, to), ...(to ? { target: { id: to._id, title: to.title } } : {}), ...(row.title ? { title: row.title } : {}),
        id: row._id, kind: row.kind, status: row.status, ...(page ? { page: { id: page._id, title: page.title } } : {}), ...(row.section ? { section: row.section } : {}),
        summary: row.summary, before: row.before.map((line) => line.text), after: row.after, ...(row.edited ? { edited: true } : {}),
        createdAt: row.createdAt, ...(row.appliedAt ? { appliedAt: row.appliedAt } : {}), ...(row.approvalId ? { approvalId: row.approvalId } : {}),
      });
    }
    return views;
  },
});
