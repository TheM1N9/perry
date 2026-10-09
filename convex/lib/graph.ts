/**
 * Brain's map (issue #225): its pages as nodes and what ties them as edges,
 * in a shape the server builds (convex/brainMap.ts) and the browser draws
 * (components/dashboard/brain-map). Pure functions with no server imports.
 */

/** What a node is: a page of each kind, the owner's own page, or a project its pages belong to. */
export type MapKind = "about" | "remember" | "journal" | "journey" | "person" | "chat" | "page" | "project";

/**
 * Why two nodes are tied. Each comes from one source (brainMap.ts, EDGE_SOURCES), so a new kind of tie,
 * such as #220's mentions and fact relations, is one more source.
 *   link     a page links to another in its words ([title](/brain/<id>), or an old /notes/ link)
 *   about    a line of a journal day or page is about someone, who has a page in People
 *   also     a line of one person's page is about another too: what that page shows under "Also about"
 *   project  a page belongs to a project
 *   mention  a line mentions a person or project (#220's mentions table)
 *   relation a line updates, extends or derives from a line on another page (#220)
 */
export type EdgeKind = "link" | "about" | "also" | "project" | "mention" | "relation";
export const EDGE_KINDS: EdgeKind[] = ["link", "about", "also", "project", "mention", "relation"];

export type MapNode = {
  id: string;
  title: string;
  kind: MapKind;
  /** A journal page's day, YYYY-MM-DD. */
  day?: string;
  projectId?: string;
  pinned: boolean;
  /** How much it holds: characters of its words (a project: how many pages). */
  size: number;
  /** When it is from, for the time filter: a journal page's day, else when it last changed. */
  at: number;
};

/** An edge between nodes[a] and nodes[b], of a kind, and how many lines or links make it. */
export type MapEdge = [a: number, b: number, kind: EdgeKind, weight: number];

export type BrainGraph = { nodes: MapNode[]; edges: MapEdge[]; projects: Array<{ id: string; name: string }> };

/** The ids of pages a page's words link to: /brain/<id> and the older /notes/<id>, as a link or written out. */
export function linkedIds(content: string): string[] {
  const found = new Set<string>();
  for (const match of content.matchAll(/\/(?:brain|notes)\/([A-Za-z0-9_-]{6,64})/g)) found.add(match[1]);
  return [...found];
}

/** Noon on a day, as a timestamp. */
export const dayTime = (day: string) => Date.parse(`${day}T12:00:00Z`);

/**
 * A node and its neighbours, `depth` steps out (Obsidian's local graph). A
 * project is a step like any other, but nothing is reached through it: else
 * every page of a project would be two steps from each other.
 */
export function around(graph: BrainGraph, id: string, depth: number): BrainGraph {
  const start = graph.nodes.findIndex((node) => node.id === id);
  if (start < 0) return { nodes: [], edges: [], projects: graph.projects };
  const next = new Map<number, number[]>();
  const link = (from: number, to: number) => { const list = next.get(from); if (list) list.push(to); else next.set(from, [to]); };
  for (const [a, b] of graph.edges) { link(a, b); link(b, a); }
  const keep = new Map<number, number>([[start, 0]]);
  let ring = [start];
  for (let step = 1; step <= depth && ring.length; step++) {
    const out: number[] = [];
    for (const at of ring) {
      if (at !== start && graph.nodes[at].kind === "project") continue;
      for (const to of next.get(at) ?? []) if (!keep.has(to)) { keep.set(to, step); out.push(to); }
    }
    ring = out;
  }
  const order = [...keep.keys()];
  const index = new Map(order.map((old, i) => [old, i]));
  return {
    nodes: order.map((old) => graph.nodes[old]),
    edges: graph.edges.filter(([a, b]) => index.has(a) && index.has(b)).map(([a, b, kind, weight]) => [index.get(a)!, index.get(b)!, kind, weight]),
    projects: graph.projects,
  };
}
