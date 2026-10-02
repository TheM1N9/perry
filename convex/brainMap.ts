import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";
import { around, dayTime, linkedIds, type BrainGraph, type EdgeKind, type MapKind, type MapNode } from "./lib/graph";
import { peopleIn, personKey } from "./lib/pages";
import { isPinned } from "./pages";

/**
 * Brain's map (issue #225), Obsidian's graph view for Brain: every page a
 * node, every tie between pages an edge. The owner's only: a dashboard query,
 * behind the dashboard key, and no tool offers it to a chat.
 *
 * Edges come from sources, each a function from the pages to the ties it
 * knows of (EDGE_SOURCES); a new kind of tie (#220's mentions table and fact
 * relations) is one more source, and the map draws it with no other change.
 */

type Note = Doc<"notes">;
type Reader = { db: QueryCtx["db"] };
type Tie = { a: string; b: string; kind: EdgeKind };
type Source = (ctx: Reader, pages: Note[]) => Promise<Tie[]>;

/** Links in a page's words to other pages. */
const links: Source = async (_ctx, pages) => {
  const known = new Set(pages.map((page) => page._id as string));
  return pages.flatMap((page) => linkedIds(page.content).filter((id) => id !== page._id && known.has(id)).map((id) => ({ a: page._id, b: id, kind: "link" as const })));
};

/**
 * Lines about people: a journal day's or page's line about someone ties it to
 * their page ("about"); a person's page's line about someone else ties the two
 * ("also", what their page shows under Also about). As People does
 * (pages.mentionsOf): current lines only, and none from a chat with someone
 * else, whose people are theirs.
 */
const people: Source = async (ctx, pages) => {
  const byPerson = new Map(pages.filter((page) => page.kind === "person" && page.person).map((page) => [page.person!, page]));
  const byId = new Map(pages.map((page) => [page._id as string, page]));
  if (!byPerson.size) return [];
  const guest = new Map<string, boolean>();
  const ties: Tie[] = [];
  // Only the lines that name someone, by index: never every line.
  const lines = await ctx.db.query("memories").withIndex("by_about", (q) => q.gte("about", "" as unknown as string[])).collect();
  for (const line of lines) {
    if (line.supersededBy || line.kind === "page" || !line.pageId || !line.about?.length) continue;
    const home = byId.get(line.pageId);
    if (!home) continue;
    if (line.conversationId) {
      if (!guest.has(line.conversationId)) guest.set(line.conversationId, Boolean((await ctx.db.get(line.conversationId))?.contactId));
      if (guest.get(line.conversationId)) continue;
    }
    for (const name of peopleIn(line.about)) {
      const person = byPerson.get(personKey(name));
      if (!person || person._id === home._id) continue;
      ties.push({ a: home._id, b: person._id, kind: home.kind === "person" ? "also" : "about" });
    }
  }
  return ties;
};

/** Pages in a project, tied to it. */
const projects: Source = async (_ctx, pages) => pages.filter((page) => page.projectId).map((page) => ({ a: page._id, b: page.projectId!, kind: "project" as const }));

/** Every source of ties, in the order they are read. */
const EDGE_SOURCES: Source[] = [links, people, projects];

const pageKind = (page: Note): MapKind => page.kind ?? "page";

/** The whole map: every page and project, and every tie, each pair and kind once with how many make it. */
export async function graphOf(ctx: Reader): Promise<BrainGraph> {
  const pages = await ctx.db.query("notes").collect();
  const projectRows = await ctx.db.query("projects").collect();
  const nodes: MapNode[] = [];
  const index = new Map<string, number>();
  const add = (node: MapNode) => { index.set(node.id, nodes.length); nodes.push(node); };
  for (const page of pages) {
    add({
      id: page._id, title: page.title, kind: pageKind(page), pinned: isPinned(page) || Boolean(page.pinnedSections?.length),
      size: page.content.length, at: page.kind === "journal" && page.day ? dayTime(page.day) : page.updatedAt,
      ...(page.day ? { day: page.day } : {}), ...(page.projectId ? { projectId: page.projectId } : {}),
    });
  }
  const inProject = new Map<string, number>();
  for (const page of pages) if (page.projectId) inProject.set(page.projectId, (inProject.get(page.projectId) ?? 0) + 1);
  for (const project of projectRows) {
    add({ id: project._id, title: project.name, kind: "project", pinned: false, size: inProject.get(project._id) ?? 0, at: project.updatedAt, projectId: project._id });
  }
  const weights = new Map<string, { a: number; b: number; kind: EdgeKind; weight: number }>();
  for (const source of EDGE_SOURCES) {
    for (const tie of await source(ctx, pages)) {
      const a = index.get(tie.a);
      const b = index.get(tie.b);
      if (a === undefined || b === undefined || a === b) continue;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const key = `${lo} ${hi} ${tie.kind}`;
      const found = weights.get(key);
      if (found) found.weight++;
      else weights.set(key, { a: lo, b: hi, kind: tie.kind, weight: 1 });
    }
  }
  return {
    nodes,
    edges: [...weights.values()].map((edge) => [edge.a, edge.b, edge.kind, edge.weight]),
    projects: projectRows.map((project) => ({ id: project._id, name: project.name })),
  };
}

/**
 * Brain's map for the dashboard: all of it, or, `around` a page, that page
 * and its neighbours `depth` steps out (1 or 2), for the page's local map.
 */
export const graph = query({
  args: { key: v.string(), around: v.optional(v.string()), depth: v.optional(v.number()) },
  handler: async (ctx, args): Promise<BrainGraph> => {
    assertDashboardKey(args.key);
    const whole = await graphOf(ctx);
    if (!args.around) return whole;
    const id = ctx.db.normalizeId("notes", args.around) ?? ctx.db.normalizeId("projects", args.around);
    return id ? around(whole, id as Id<"notes"> | Id<"projects">, Math.min(Math.max(Math.round(args.depth ?? 1), 1), 2)) : { nodes: [], edges: [], projects: whole.projects };
  },
});
