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

/**
 * The whole map: every page and project, and every tie, each pair and kind once with how many make it. With
 * `scope`, only the pages and projects it keeps (what a chat may reach: Perry's brain_neighbors and recall).
 */
export async function graphOf(ctx: Reader, scope?: { page: (page: Note) => boolean; project: (id: Id<"projects">) => boolean }): Promise<BrainGraph> {
  const pages = (await ctx.db.query("notes").collect()).filter((page) => !scope || scope.page(page));
  const projectRows = (await ctx.db.query("projects").collect()).filter((project) => !scope || scope.project(project._id));
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
 * Only the part of the map within `depth` steps of some pages, read from those
 * pages outwards and never from all of Brain: what Perry's brain_neighbors and
 * recall's one step out need (issue #230), cheap with years of pages. The same
 * ties as graphOf, each counted once, so around() on it gives what around()
 * on the whole map gives within that reach:
 *   link     the links in a page's words, and the pages whose words link to it (found by the word index on the id);
 *   about    a person's lines from the mentions index (pages.noteMentions), kept to those `about` them, as graphOf;
 *   project  a page's project, which is a step like any other but leads nowhere further.
 * Until every line's mentions are kept (pages.indexMentions), a person's lines are read by the by_about index.
 */
export async function neighbourhoodOf(ctx: Reader, seeds: string[], depth: number, scope: { page: (page: Note) => boolean; project: (id: Id<"projects">) => boolean }): Promise<BrainGraph> {
  const pages = new Map<string, Note>();
  const projects = new Map<string, Doc<"projects">>();
  const persons = new Map<string, Note | null>();
  const ties = new Map<string, Tie>();
  const tie = (key: string, value: Tie) => { if (!ties.has(key)) ties.set(key, value); };
  const pageOf = async (raw: string): Promise<Note | null> => {
    if (pages.has(raw)) return pages.get(raw)!;
    const id = ctx.db.normalizeId("notes", raw);
    const page = id ? await ctx.db.get(id) : null;
    if (!page || !scope.page(page)) return null;
    pages.set(page._id, page);
    return page;
  };
  const personPage = async (name: string): Promise<Note | null> => {
    const key = personKey(name);
    if (!persons.has(key)) {
      const found = (await ctx.db.query("notes").withIndex("by_person", (q) => q.eq("person", key)).collect()).find((page) => page.kind === "person" && scope.page(page)) ?? null;
      persons.set(key, found);
      if (found) pages.set(found._id, found);
    }
    return persons.get(key)!;
  };
  const guests = new Map<string, boolean>();
  const fromGuest = async (line: Doc<"memories">) => {
    if (!line.conversationId) return false;
    if (!guests.has(line.conversationId)) guests.set(line.conversationId, Boolean((await ctx.db.get(line.conversationId))?.contactId));
    return guests.get(line.conversationId)!;
  };
  /** A line about people ties its page to theirs, as graphOf's people source does. */
  const aboutTies = async (line: Doc<"memories">, home: Note, only?: string): Promise<Note[]> => {
    if (line.supersededBy || line.kind === "page" || !line.about?.length || line.pageId !== home._id || await fromGuest(line)) return [];
    const reached: Note[] = [];
    for (const name of peopleIn(line.about)) {
      if (only && personKey(name) !== only) continue;
      const person = await personPage(name);
      if (!person || person._id === home._id) continue;
      tie(`${line._id} ${person._id}`, { a: home._id, b: person._id, kind: home.kind === "person" ? "also" : "about" });
      reached.push(person);
    }
    return reached;
  };
  const mentionsKept = (await ctx.db.query("installation").first())?.mentionsAt === Number.MAX_SAFE_INTEGER;

  /** Every page or project tied to this page, with the ties recorded. */
  const expand = async (page: Note): Promise<string[]> => {
    const next: string[] = [];
    for (const id of linkedIds(page.content)) {
      const other = id === page._id ? null : await pageOf(id);
      if (other) { tie(`link ${page._id} ${other._id}`, { a: page._id, b: other._id, kind: "link" }); next.push(other._id); }
    }
    for (const other of await ctx.db.query("notes").withSearchIndex("search_text", (q) => q.search("search", `${page._id} `)).take(1024)) {
      if (other._id === page._id || !scope.page(other) || !linkedIds(other.content).includes(page._id)) continue;
      pages.set(other._id, other);
      tie(`link ${other._id} ${page._id}`, { a: other._id, b: page._id, kind: "link" });
      next.push(other._id);
    }
    // Its own lines about people.
    for (const line of await ctx.db.query("memories").withIndex("by_page", (q) => q.eq("pageId", page._id)).collect()) {
      for (const person of await aboutTies(line, page)) next.push(person._id);
    }
    // For a person, the lines about them on other pages.
    if (page.kind === "person" && page.person) {
      const lines = mentionsKept
        ? (await Promise.all((await ctx.db.query("mentions").withIndex("by_person", (q) => q.eq("person", page.person)).collect()).map((mention) => ctx.db.get(mention.lineId)))).filter((line): line is Doc<"memories"> => Boolean(line))
        : await ctx.db.query("memories").withIndex("by_about", (q) => q.gte("about", "" as unknown as string[])).collect();
      for (const line of lines) {
        if (!line.pageId || line.pageId === page._id || !line.about?.length) continue;
        const home = await pageOf(line.pageId);
        if (home && (await aboutTies(line, home, page.person)).length) next.push(home._id);
      }
    }
    if (page.projectId && scope.project(page.projectId)) {
      if (!projects.has(page.projectId)) { const project = await ctx.db.get(page.projectId); if (project) projects.set(project._id, project); }
      if (projects.has(page.projectId)) tie(`project ${page._id}`, { a: page._id, b: page.projectId, kind: "project" });
    }
    return next;
  };

  const steps = new Map<string, number>();
  let ring: string[] = [];
  for (const seed of seeds) {
    const page = await pageOf(seed);
    if (page && !steps.has(page._id)) { steps.set(page._id, 0); ring.push(page._id); }
  }
  for (let step = 1; step <= depth && ring.length; step++) {
    const out: string[] = [];
    for (const id of ring) for (const to of await expand(pages.get(id)!)) if (!steps.has(to)) { steps.set(to, step); out.push(to); }
    ring = out;
  }

  const nodes: MapNode[] = [];
  const index = new Map<string, number>();
  const add = (node: MapNode) => { index.set(node.id, nodes.length); nodes.push(node); };
  for (const page of pages.values()) {
    add({
      id: page._id, title: page.title, kind: pageKind(page), pinned: isPinned(page) || Boolean(page.pinnedSections?.length),
      size: page.content.length, at: page.kind === "journal" && page.day ? dayTime(page.day) : page.updatedAt,
      ...(page.day ? { day: page.day } : {}), ...(page.projectId ? { projectId: page.projectId } : {}),
    });
  }
  for (const project of projects.values()) add({ id: project._id, title: project.name, kind: "project", pinned: false, size: 0, at: project.updatedAt, projectId: project._id });
  const weights = new Map<string, { a: number; b: number; kind: EdgeKind; weight: number }>();
  for (const found of ties.values()) {
    const a = index.get(found.a);
    const b = index.get(found.b);
    if (a === undefined || b === undefined || a === b) continue;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo} ${hi} ${found.kind}`;
    const known = weights.get(key);
    if (known) known.weight++;
    else weights.set(key, { a: lo, b: hi, kind: found.kind, weight: 1 });
  }
  return {
    nodes,
    edges: [...weights.values()].map((edge) => [edge.a, edge.b, edge.kind, edge.weight]),
    projects: [...projects.values()].map((project) => ({ id: project._id, name: project.name })),
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
