"use client";

import { cn } from "cn";
import { useEffect, useMemo, useRef } from "react";
import type { BrainGraph, MapKind, MapNode } from "@/convex/lib/graph";
import type { FromLayout, ToLayout } from "./layout-worker";

/**
 * Brain's map, drawn on a canvas (issue #225). The layout runs in a worker
 * (layout-worker.ts); this draws whatever positions it last sent, and only
 * when something changed: new positions, a pan or zoom, a hover. Edges are
 * stroked in a few batched paths and nodes filled a colour at a time, so
 * thousands of pages and tens of thousands of edges stay smooth.
 *
 * Years of Brain stay readable the way a paper map does: zoomed out, journal
 * days are a month to a dot, laid out along a timeline, and only the most
 * tied-to pages are drawn (projects, About me, Things to remember, pinned
 * pages, the people and pages most linked), as many as fit the screen, with
 * the strongest of their links and no two names overlapping; zooming in
 * reveals the rest. Hovering a page shows all of its neighbours.
 */

export const KIND_COLOR: Record<MapKind, string> = {
  about: "--primary", remember: "--chart-2", journal: "--chart-4", journey: "--success", person: "--chart-3", page: "--foreground", chat: "--chart-4", project: "--primary",
};
const KINDS = Object.keys(KIND_COLOR) as MapKind[];
/** Below this zoom, journal days are drawn a month to a dot. */
const MONTHS_BELOW = 0.45;
const MIN_ZOOM = 0.04;
const MAX_ZOOM = 6;
/** A map this small is drawn whole at any zoom. */
const SMALL = 300;
/**
 * Zoomed out to fit, a large map draws this many of its most tied-to pages, and four times as many at twice the zoom
 * (the same number per screen). About 150 dots, most of them named, is what a 1280×800 window reads at a glance.
 */
const SHOWN_AT_FIT = 150;
/**
 * At most this many links are drawn at once, the strongest first. On a map about 1000×560 pixels, 1,200 hairlines a
 * hundred-odd pixels long already cross a third of it; past that the lines read as a grey fill, not as links.
 */
const EDGE_BUDGET = 1200;

/** What is drawn: each node shown (or a month of journal days), and the edges between them. */
type View = {
  count: number;
  /** Graph node to drawn node, or -1 when hidden. */
  rep: Int32Array;
  /** Drawn node to its graph nodes, as offsets into `members`. */
  start: Int32Array;
  members: Int32Array;
  kind: MapKind[];
  title: string[];
  /** Radius in map units. */
  radius: Float32Array;
  pinned: Uint8Array;
  group: Uint8Array;
  /** Edges as pairs of drawn nodes, how many ties each stands for, strongest first, and each node's neighbours (CSR). */
  edges: Int32Array;
  weight: Float32Array;
  order: Int32Array;
  adjStart: Int32Array;
  adj: Int32Array;
  /** How important each node is, 0 the most: hubs, then the most tied-to. */
  rank: Int32Array;
};

const MONTH = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });

function buildView(graph: BrainGraph, visible: Uint8Array, months: boolean): View {
  const n = graph.nodes.length;
  const rep = new Int32Array(n).fill(-1);
  const groups: number[][] = [];
  const byMonth = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (!visible[i]) continue;
    const node = graph.nodes[i];
    if (months && node.kind === "journal" && node.day) {
      const key = `${node.day.slice(0, 7)} ${node.projectId ?? ""}`;
      let at = byMonth.get(key);
      if (at === undefined) { at = groups.length; byMonth.set(key, at); groups.push([]); }
      groups[at].push(i);
      rep[i] = at;
    } else {
      rep[i] = groups.length;
      groups.push([i]);
    }
  }
  const count = groups.length;
  const start = new Int32Array(count + 1);
  const members = new Int32Array(groups.reduce((sum, group) => sum + group.length, 0));
  const kind: MapKind[] = [];
  const title: string[] = [];
  const radius = new Float32Array(count);
  const pinned = new Uint8Array(count);
  const group = new Uint8Array(count);
  let at = 0;
  for (let g = 0; g < count; g++) {
    start[g] = at;
    let size = 0;
    for (const i of groups[g]) { members[at++] = i; size += graph.nodes[i].size; }
    const first = graph.nodes[groups[g][0]];
    const many = months && first.kind === "journal" && Boolean(first.day);
    kind.push(first.kind);
    title.push(many ? MONTH.format(new Date(`${first.day!.slice(0, 7)}-15T12:00:00Z`)) : first.title);
    group[g] = many ? 1 : 0;
    pinned[g] = groups[g].some((i) => graph.nodes[i].pinned) ? 1 : 0;
    radius[g] = many ? Math.min(28, 5 + Math.sqrt(groups[g].length) * 2.2) : 0;
    if (!many) radius[g] = Math.min(18, 3.2 + Math.sqrt(size) / 14);
  }
  start[count] = at;
  // Edges between what is drawn, each pair once.
  const seen = new Map<number, number>();
  const pairs: number[] = [];
  const weights: number[] = [];
  const degree = new Int32Array(count);
  for (const [a, b, , w] of graph.edges) {
    const ra = rep[a];
    const rb = rep[b];
    if (ra < 0 || rb < 0 || ra === rb) continue;
    const lo = Math.min(ra, rb);
    const hi = Math.max(ra, rb);
    const key = lo * count + hi;
    const found = seen.get(key);
    if (found !== undefined) { weights[found] += w; continue; }
    seen.set(key, weights.length);
    pairs.push(lo, hi);
    weights.push(w);
    degree[lo]++;
    degree[hi]++;
  }
  const edges = Int32Array.from(pairs);
  const weight = Float32Array.from(weights);
  const order = Int32Array.from(weights.keys()).sort((a, b) => weight[b] - weight[a]);
  const adjStart = new Int32Array(count + 1);
  for (let i = 0; i < count; i++) adjStart[i + 1] = adjStart[i] + degree[i];
  const fill = adjStart.slice(0, count);
  const adj = new Int32Array(edges.length);
  for (let e = 0; e < edges.length; e += 2) { adj[fill[edges[e]]++] = edges[e + 1]; adj[fill[edges[e + 1]]++] = edges[e]; }
  // A page tied to many grows a little, so hubs read as hubs.
  for (let g = 0; g < count; g++) if (!group[g]) radius[g] = Math.min(22, radius[g] + Math.sqrt(adjStart[g + 1] - adjStart[g]) * 0.6);
  // Hubs first (projects, About me, Things to remember, what is pinned), then by how many they are tied to.
  const score = new Float64Array(count);
  for (let g = 0; g < count; g++) {
    const hub = kind[g] === "project" ? 4 : kind[g] === "about" || kind[g] === "remember" ? 3 : pinned[g] ? 2 : 0;
    score[g] = hub * 1e6 + (adjStart[g + 1] - adjStart[g]) * 10 + radius[g];
  }
  const rank = new Int32Array(count);
  Int32Array.from(score.keys()).sort((a, b) => score[b] - score[a]).forEach((g, place) => { rank[g] = place; });
  return { count, rep, start, members, kind, title, radius, pinned, group, edges, weight, order, adjStart, adj, rank };
}

/** The colours of Perry's tokens, as they are now (light or dark). */
function readColors(element: Element) {
  const style = getComputedStyle(element);
  const token = (name: string) => style.getPropertyValue(name).trim() || "#888";
  return {
    kind: Object.fromEntries(KINDS.map((kind) => [kind, token(KIND_COLOR[kind])])) as Record<MapKind, string>,
    edge: token("--muted-foreground"), accent: token("--primary"), text: token("--foreground"), muted: token("--muted-foreground"), background: token("--background"),
    font: style.fontFamily || "sans-serif",
  };
}

export type MapHandle = {
  /** Where a page is on screen, relative to the canvas, or null when it is not drawn. */
  screenOf: (id: string) => { x: number; y: number } | null;
  /** The page drawn at a point on the canvas, if any. */
  nodeAt: (x: number, y: number) => string | null;
  /** When the data came (the map mounted with it), the first draw, how long each draw and each frame took. */
  stats: {
    dataAt: number; firstDraw: number; draws: number[]; frames: number[]; drawn: { nodes: number; edges: number; months: boolean }; settled: boolean;
    /** The names drawn last, as boxes on screen (left, top, right, bottom). */
    labels: Array<[number, number, number, number]>;
  };
};

export function GraphView({
  graph, visible, focus, center, onOpen, label, className, months = true, labelAll = false,
}: {
  graph: BrainGraph;
  /** One per node: 1 when it is shown. Unset: all. */
  visible?: Uint8Array;
  /** A node to centre on and keep highlighted (search). */
  focus?: string | null;
  /** The page a local map is of, always named. */
  center?: string;
  onOpen: (node: MapNode) => void;
  label: string;
  className?: string;
  /** Journal days a month to a dot when zoomed out. */
  months?: boolean;
  /** Name every node (a small local map). */
  labelAll?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shown = useMemo(() => visible ?? new Uint8Array(graph.nodes.length).fill(1), [visible, graph]);
  const views = useMemo(() => ({ full: buildView(graph, shown, false), months: months ? buildView(graph, shown, true) : null }), [graph, shown, months]);
  const focusIndex = useMemo(() => (focus ? graph.nodes.findIndex((node) => node.id === focus) : -1), [graph, focus]);
  const centerIndex = useMemo(() => (center ? graph.nodes.findIndex((node) => node.id === center) : -1), [graph, center]);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  /** Everything the drawing reads, kept out of React so a frame never waits on a render. */
  const state = useRef({
    graph, views, focusIndex, centerIndex, labelAll,
    positions: new Float32Array(0) as Float32Array, hasPositions: false, settled: false,
    k: 1, tx: 0, ty: 0, width: 0, height: 0, dpr: 1, moved: false,
    hover: -1, drag: -1, colors: null as ReturnType<typeof readColors> | null,
    frame: 0, worker: null as Worker | null, placed: graph as BrainGraph,
    stats: { dataAt: performance.now(), firstDraw: 0, draws: [] as number[], frames: [] as number[], drawn: { nodes: 0, edges: 0, months: false }, settled: false, labels: [] as Array<[number, number, number, number]> },
    pendingFocus: -1, lastFrame: 0, fitK: 0,
    /** What the last frame drew, for hit-testing: only a drawn node can be hovered or clicked. */
    drawn: new Uint8Array(0), drawnView: null as View | null,
  });

  const s = state.current;
  s.graph = graph;
  s.views = views;
  s.labelAll = labelAll;

  // Draw on the next frame, once, however many things asked.
  const request = () => {
    if (s.frame) return;
    s.frame = requestAnimationFrame((now) => {
      s.frame = 0;
      if (s.lastFrame) { s.stats.frames.push(now - s.lastFrame); if (s.stats.frames.length > 240) s.stats.frames.shift(); }
      s.lastFrame = now;
      draw();
    });
  };

  /** Positions for the graph being drawn: a new graph waits for its first from the worker. */
  const ready = () => s.hasPositions && s.positions.length === s.views.full.rep.length * 2;
  const view = (): View => (s.views.months && s.k < MONTHS_BELOW ? s.views.months : s.views.full);
  /** Drawn node positions: a month of journal days sits at the middle of its days. */
  const place = (v: View) => {
    const xy = new Float32Array(v.count * 2);
    for (let g = 0; g < v.count; g++) {
      let x = 0;
      let y = 0;
      const from = v.start[g];
      const to = v.start[g + 1];
      for (let m = from; m < to; m++) { x += s.positions[v.members[m] * 2]; y += s.positions[v.members[m] * 2 + 1]; }
      xy[g * 2] = x / (to - from);
      xy[g * 2 + 1] = y / (to - from);
    }
    return xy;
  };

  /** How many of a view's nodes are drawn at this zoom, by rank: all of a small map; of a large one, as many as fit. */
  const reveal = (v: View) => (v.count <= SMALL || !s.fitK ? v.count : Math.max(SHOWN_AT_FIT, Math.round(SHOWN_AT_FIT * (s.k / s.fitK) ** 2)));

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas || !ready() || !s.width) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const began = performance.now();
    const colors = (s.colors ??= readColors(canvas));
    const v = view();
    const xy = place(v);
    const { k, tx, ty, dpr } = s;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, s.width, s.height);
    // What is on screen, in map units, with a margin for big nodes.
    const pad = 30 / k;
    const left = -tx / k - pad;
    const top = -ty / k - pad;
    const right = (s.width - tx) / k + pad;
    const bottom = (s.height - ty) / k + pad;
    const inside = (g: number) => xy[g * 2] >= left && xy[g * 2] <= right && xy[g * 2 + 1] >= top && xy[g * 2 + 1] <= bottom;

    const focusAt = s.focusIndex >= 0 ? v.rep[s.focusIndex] : -1;
    const centerAt = s.centerIndex >= 0 ? v.rep[s.centerIndex] : -1;
    const lit = s.hover >= 0 ? s.hover : focusAt;
    const near = new Set<number>();
    if (lit >= 0) for (let a = v.adjStart[lit]; a < v.adjStart[lit + 1]; a++) near.add(v.adj[a]);
    // What is drawn: the most important, as many as the zoom allows, and the lit page's neighbours whatever their rank.
    const limit = reveal(v);
    const drawn = new Uint8Array(v.count);
    for (let g = 0; g < v.count; g++) drawn[g] = (v.rank[g] < limit || near.has(g) || g === lit || g === centerAt) && inside(g) ? 1 : 0;
    s.drawn = drawn;
    s.drawnView = v;

    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    // Links: hairlines, the strongest first, within the budget; a journal's fainter, as there are so many.
    ctx.lineWidth = 1 / k;
    ctx.strokeStyle = colors.edge;
    const big = v.count > SMALL;
    const base = lit >= 0 ? 0.07 : big ? 0.2 : 0.25;
    const strong = new Path2D();
    const faint = new Path2D();
    let edgesDrawn = 0;
    for (let o = 0; o < v.order.length && edgesDrawn < EDGE_BUDGET; o++) {
      const e = v.order[o];
      const ga = v.edges[e * 2];
      const gb = v.edges[e * 2 + 1];
      if (!drawn[ga] || !drawn[gb]) continue;
      const path = big && (v.group[ga] || v.group[gb] || v.kind[ga] === "journal" || v.kind[gb] === "journal") ? faint : strong;
      path.moveTo(xy[ga * 2], xy[ga * 2 + 1]);
      path.lineTo(xy[gb * 2], xy[gb * 2 + 1]);
      edgesDrawn++;
    }
    ctx.globalAlpha = base;
    ctx.stroke(strong);
    ctx.globalAlpha = base * 0.45;
    ctx.stroke(faint);
    if (lit >= 0) {
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1.5 / k;
      ctx.beginPath();
      for (const to of near) { ctx.moveTo(xy[lit * 2], xy[lit * 2 + 1]); ctx.lineTo(xy[to * 2], xy[to * 2 + 1]); }
      ctx.stroke();
    }
    // Nodes, a colour at a time; dimmed when another is lit and they are not its neighbours.
    let nodesDrawn = 0;
    // However far out, a dot stays a few pixels wide, a hub's a little more.
    const size = (g: number) => Math.max(v.radius[g], (v.rank[g] < 60 ? 4 : 2.2) / k);
    for (const dim of lit >= 0 ? [true, false] : [false]) {
      for (const kind of KINDS) {
        ctx.fillStyle = colors.kind[kind];
        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.beginPath();
        for (let g = 0; g < v.count; g++) {
          if (v.kind[g] !== kind || !drawn[g]) continue;
          const faded = lit >= 0 && g !== lit && !near.has(g);
          if (faded !== dim) continue;
          const x = xy[g * 2], y = xy[g * 2 + 1], r = size(g);
          if (kind === "project") ctx.rect(x - r, y - r, r * 2, r * 2);
          else { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
          nodesDrawn++;
        }
        ctx.fill();
      }
    }
    // Pinned pages wear a ring; the lit one and the page a local map is of, a bolder one.
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.5 / Math.max(k, 0.5);
    ctx.beginPath();
    for (let g = 0; g < v.count; g++) {
      if (!v.pinned[g] || !drawn[g]) continue;
      const r = size(g) + 2.5 / Math.max(k, 0.5);
      ctx.moveTo(xy[g * 2] + r, xy[g * 2 + 1]);
      ctx.arc(xy[g * 2], xy[g * 2 + 1], r, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.strokeStyle = colors.text;
    ctx.lineWidth = 2 / k;
    ctx.beginPath();
    for (const g of [lit, centerAt]) {
      if (g < 0) continue;
      const r = size(g) + 4 / k;
      ctx.moveTo(xy[g * 2] + r, xy[g * 2 + 1]);
      ctx.arc(xy[g * 2], xy[g * 2 + 1], r, 0, Math.PI * 2);
    }
    ctx.stroke();

    // Names, in screen pixels, each only where no other is: the lit page, its neighbours and the local map's page
    // first, then the most important. Big enough on screen, or a small map near its own size, or zoomed well in.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const wanted = (g: number) => s.labelAll || g === lit || g === centerAt || near.has(g)
      || (lit < 0 && (v.radius[g] * k >= 6 || (!big && k >= 0.9) || k >= 1.8 || v.group[g] === 1 || (big && v.rank[g] < 60)));
    const candidates: number[] = [];
    for (let g = 0; g < v.count; g++) if (drawn[g] && wanted(g)) candidates.push(g);
    const priority = (g: number) => (g === lit || g === centerAt ? -2e6 : near.has(g) ? -1e6 : 0) + v.rank[g];
    candidates.sort((a, b) => priority(a) - priority(b));
    const CELL = 8;
    const taken = new Set<number>();
    const labels: Array<{ g: number; text: string; x: number; y: number; font: string; strong: boolean }> = [];
    const boxes: Array<[number, number, number, number]> = [];
    for (const g of candidates) {
      if (labels.length >= 250) break;
      const strongName = g === lit || g === centerAt;
      const font = `${strongName ? 600 : 400} ${strongName ? 13 : 12}px ${colors.font}`;
      ctx.font = font;
      const text = v.title[g].length > 40 ? `${v.title[g].slice(0, 39)}…` : v.title[g];
      const width = ctx.measureText(text).width;
      const x = xy[g * 2] * k + tx;
      const y = (xy[g * 2 + 1] + size(g)) * k + ty + 4;
      const box: [number, number, number, number] = [x - width / 2 - 2, y - 1, x + width / 2 + 2, y + 16];
      // Every cell the box touches must be free, so two names never share a pixel.
      const cells: number[] = [];
      let free = true;
      for (let cx = Math.floor(box[0] / CELL); cx <= Math.floor(box[2] / CELL) && free; cx++) {
        for (let cy = Math.floor(box[1] / CELL); cy <= Math.floor(box[3] / CELL); cy++) {
          const key = cx * 100_003 + cy;
          if (taken.has(key)) { free = false; break; }
          cells.push(key);
        }
      }
      if (!free) continue;
      for (const key of cells) taken.add(key);
      labels.push({ g, text, x, y, font, strong: strongName });
      boxes.push(box);
    }
    // Halo first, so names stay readable over links.
    for (const pass of ["halo", "text"] as const) {
      for (const label of labels) {
        ctx.font = label.font;
        if (pass === "halo") {
          ctx.globalAlpha = 0.85;
          ctx.lineWidth = 3;
          ctx.strokeStyle = colors.background;
          ctx.strokeText(label.text, label.x, label.y);
        } else {
          ctx.globalAlpha = lit >= 0 && !label.strong && !near.has(label.g) ? 0.4 : 1;
          ctx.fillStyle = label.strong ? colors.text : colors.muted;
          ctx.fillText(label.text, label.x, label.y);
        }
      }
    }
    ctx.globalAlpha = 1;
    const took = performance.now() - began;
    s.stats.draws.push(took);
    if (s.stats.draws.length > 240) s.stats.draws.shift();
    if (!s.stats.firstDraw && v.count) s.stats.firstDraw = performance.now();
    s.stats.drawn = { nodes: nodesDrawn, edges: edgesDrawn, months: v !== s.views.full };
    s.stats.labels = boxes;
    canvas.dataset.drawnNodes = String(nodesDrawn);
    canvas.dataset.drawnEdges = String(edgesDrawn);
    canvas.dataset.view = v === s.views.full ? "pages" : "months";
    canvas.dataset.lit = lit >= 0 ? v.title[lit] : "";
    canvas.dataset.litNeighbours = String(near.size);
  }

  /** Fit what is shown into the canvas; `apply` false only notes the zoom that would (what `reveal` counts from). */
  const fit = (apply = true) => {
    if (!s.views.full.count || !s.width || !ready()) return;
    // A large map fits what it draws zoomed out (its most important), not every page out to the last.
    const big = s.views.full.count > SMALL;
    const v = big ? s.views.months ?? s.views.full : s.views.full;
    const xy = place(v);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let g = 0; g < v.count; g++) {
      if (big && v.rank[g] >= SHOWN_AT_FIT) continue;
      minX = Math.min(minX, xy[g * 2]); maxX = Math.max(maxX, xy[g * 2]);
      minY = Math.min(minY, xy[g * 2 + 1]); maxY = Math.max(maxY, xy[g * 2 + 1]);
    }
    const margin = 40;
    const k = Math.min(MAX_ZOOM / 2, Math.max(MIN_ZOOM, Math.min((s.width - margin * 2) / Math.max(maxX - minX, 1), (s.height - margin * 2) / Math.max(maxY - minY, 1))));
    s.fitK = k;
    if (!apply) return;
    s.k = k;
    s.tx = s.width / 2 - ((minX + maxX) / 2) * k;
    s.ty = s.height / 2 - ((minY + maxY) / 2) * k;
  };
  const centreOn = (index: number) => {
    if (!ready() || index < 0) { s.pendingFocus = index; return; }
    s.k = Math.max(s.k, 1.4);
    s.tx = s.width / 2 - s.positions[index * 2] * s.k;
    s.ty = s.height / 2 - s.positions[index * 2 + 1] * s.k;
    s.moved = true;
    s.pendingFocus = -1;
  };

  // The worker, for as long as the map is open.
  useEffect(() => {
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL("./layout-worker.ts", import.meta.url), { type: "module" });
    } catch {
      return;
    }
    s.worker = worker;
    worker.onmessage = ({ data }: MessageEvent<FromLayout>) => {
      if (data.positions.length !== s.graph.nodes.length * 2) return;
      s.positions = data.positions;
      s.placed = s.graph;
      s.hasPositions = true;
      s.settled = data.settled;
      s.stats.settled = data.settled;
      fit(!s.moved && s.pendingFocus < 0);
      if (s.pendingFocus >= 0) centreOn(s.pendingFocus);
      if (canvasRef.current) canvasRef.current.dataset.settled = String(data.settled);
      request();
    };
    return () => { worker?.terminate(); s.worker = null; if (s.frame) cancelAnimationFrame(s.frame); s.frame = 0; };
  }, []);

  // A new shape of graph (pages or ties added or gone) is laid out again from where each page was.
  const shape = useMemo(() => `${graph.nodes.map((node) => node.id).join(",")}|${graph.edges.map((edge) => `${edge[0]}-${edge[1]}`).join(",")}`, [graph]);
  useEffect(() => {
    const worker = s.worker;
    if (!worker) return;
    const n = graph.nodes.length;
    const positions = new Float32Array(n * 2);
    const known = new Uint8Array(n);
    let knownCount = 0;
    // Where each page was in the last layout, by id.
    const was = new Map<string, number>();
    if (s.hasPositions && s.positions.length === s.placed.nodes.length * 2) s.placed.nodes.forEach((node, i) => was.set(node.id, i));
    graph.nodes.forEach((node, i) => {
      const at = was.get(node.id);
      if (at !== undefined) { positions[i * 2] = s.positions[at * 2]; positions[i * 2 + 1] = s.positions[at * 2 + 1]; known[i] = 1; knownCount++; }
    });
    const pairs = new Map<string, number>();
    for (const [a, b, , weight] of graph.edges) pairs.set(`${a} ${b}`, (pairs.get(`${a} ${b}`) ?? 0) + weight);
    const links = new Int32Array(pairs.size * 2);
    const weights = new Float32Array(pairs.size);
    let at = 0;
    for (const [key, weight] of pairs) { const [a, b] = key.split(" ").map(Number); links[at * 2] = a; links[at * 2 + 1] = b; weights[at++] = weight; }
    // A large map's journal as a timeline: months in order, each project's apart.
    const month = new Int32Array(n).fill(-1);
    const keys = new Map<string, number>();
    if (months && n > SMALL) {
      graph.nodes.forEach((node, i) => {
        if (node.kind !== "journal" || !node.day) return;
        const key = `${node.projectId ?? ""} ${node.day.slice(0, 7)}`;
        if (!keys.has(key)) keys.set(key, keys.size);
        month[i] = keys.get(key)!;
      });
    }
    const sorted = [...keys].sort(([a], [b]) => a.localeCompare(b));
    const chain: number[] = [];
    for (let i = 1; i < sorted.length; i++) if (sorted[i][0].split(" ")[0] === sorted[i - 1][0].split(" ")[0]) chain.push(sorted[i - 1][1], sorted[i][1]);
    const order = Int32Array.from(chain);
    // Each month's place on the timeline, by its date alone (a project's days line up with everyone's).
    const dates = [...new Set(sorted.map(([key]) => key.split(" ")[1]))].sort();
    const step = Math.max(25, 1600 / Math.max(dates.length, 1));
    const monthX = new Float32Array(keys.size);
    for (const [key, at] of keys) monthX[at] = (dates.indexOf(key.split(" ")[1]) - (dates.length - 1) / 2) * step;
    // Mostly known already: a gentle nudge, not a fresh layout.
    const heat = knownCount === 0 ? 1 : knownCount === n ? 0.1 : 0.3;
    const message: ToLayout = { type: "init", count: n, links, weights, positions, known, heat, month, months: keys.size, chain: order, monthX };
    worker.postMessage(message, [links.buffer, weights.buffer, positions.buffer, known.buffer, month.buffer, order.buffer, monthX.buffer]);
  }, [shape]);

  useEffect(() => { s.focusIndex = focusIndex; if (focusIndex >= 0) centreOn(focusIndex); request(); }, [focusIndex]);
  useEffect(() => { s.centerIndex = centerIndex; request(); }, [centerIndex]);
  useEffect(() => { s.hover = -1; request(); }, [views]);

  // Size, theme and input.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const box = canvas.getBoundingClientRect();
      s.dpr = window.devicePixelRatio || 1;
      s.width = box.width;
      s.height = box.height;
      canvas.width = Math.round(box.width * s.dpr);
      canvas.height = Math.round(box.height * s.dpr);
      fit(!s.moved);
      request();
    };
    const sized = new ResizeObserver(resize);
    sized.observe(canvas);
    resize();
    // Light or dark: the html element's class changes, and the colours with it.
    const themed = new MutationObserver(() => { s.colors = null; request(); });
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });

    const local = (event: { clientX: number; clientY: number }) => {
      const box = canvas.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };
    const hit = (x: number, y: number): number => {
      if (!ready()) return -1;
      const v = view();
      const xy = place(v);
      const mx = (x - s.tx) / s.k;
      const my = (y - s.ty) / s.k;
      let best = -1;
      let bestD = Infinity;
      const shownNow = s.drawnView === v ? s.drawn : null;
      for (let g = 0; g < v.count; g++) {
        if (shownNow && !shownNow[g]) continue;
        const dx = xy[g * 2] - mx;
        const dy = xy[g * 2 + 1] - my;
        const d = dx * dx + dy * dy;
        const r = Math.max(v.radius[g], (v.rank[g] < 60 ? 4 : 2.2) / s.k) + 4 / s.k;
        if (d <= r * r && d < bestD) { best = g; bestD = d; }
      }
      return best;
    };
    let press: { x: number; y: number; node: number; panX: number; panY: number; moved: boolean; id: number } | null = null;
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const at = local(event);
      press = { x: at.x, y: at.y, node: hit(at.x, at.y), panX: s.tx, panY: s.ty, moved: false, id: event.pointerId };
      try { canvas.setPointerCapture(event.pointerId); } catch {}
    };
    const move = (event: PointerEvent) => {
      const at = local(event);
      if (!press) {
        const over = hit(at.x, at.y);
        if (over !== s.hover) { s.hover = over; canvas.style.cursor = over >= 0 ? "pointer" : "grab"; request(); }
        return;
      }
      if (!press.moved && Math.hypot(at.x - press.x, at.y - press.y) < 4) return;
      press.moved = true;
      s.moved = true;
      const v = view();
      if (press.node >= 0 && !v.group[press.node]) {
        // Drag the page: the layout holds it under the pointer, and its neighbours follow.
        const index = v.members[v.start[press.node]];
        const x = (at.x - s.tx) / s.k;
        const y = (at.y - s.ty) / s.k;
        s.positions[index * 2] = x;
        s.positions[index * 2 + 1] = y;
        s.drag = index;
        s.worker?.postMessage({ type: "drag", index, x, y } satisfies ToLayout);
        canvas.style.cursor = "grabbing";
      } else {
        s.tx = press.panX + at.x - press.x;
        s.ty = press.panY + at.y - press.y;
        canvas.style.cursor = "grabbing";
      }
      request();
    };
    const up = (event: PointerEvent) => {
      if (!press) return;
      const was = press;
      press = null;
      try { canvas.releasePointerCapture(event.pointerId); } catch {}
      canvas.style.cursor = s.hover >= 0 ? "pointer" : "grab";
      if (s.drag >= 0) { s.worker?.postMessage({ type: "release", index: s.drag } satisfies ToLayout); s.drag = -1; }
      if (was.moved || was.node < 0) return;
      const v = view();
      if (v.group[was.node]) {
        // A month of journal days opens up: zoom in on it.
        const xy = place(v);
        s.k = Math.max(MONTHS_BELOW * 1.6, s.k);
        s.tx = s.width / 2 - xy[was.node * 2] * s.k;
        s.ty = s.height / 2 - xy[was.node * 2 + 1] * s.k;
        s.moved = true;
        s.hover = -1;
        request();
        return;
      }
      onOpenRef.current(s.graph.nodes[v.members[v.start[was.node]]]);
    };
    const leave = () => { if (!press && s.hover >= 0) { s.hover = -1; request(); } };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const at = local(event);
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s.k * factor));
      s.tx = at.x - ((at.x - s.tx) / s.k) * k;
      s.ty = at.y - ((at.y - s.ty) / s.k) * k;
      s.k = k;
      s.moved = true;
      request();
    };
    const again = () => { s.moved = false; fit(); request(); };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("dblclick", again);
    canvas.style.cursor = "grab";
    // For the end-to-end check: where a page is drawn, and how long frames take.
    (canvas as HTMLCanvasElement & { brainMap?: MapHandle }).brainMap = {
      screenOf: (id) => {
        const index = s.graph.nodes.findIndex((node) => node.id === id);
        const v = view();
        if (index < 0 || !ready() || v.rep[index] < 0) return null;
        const xy = place(v);
        const g = v.rep[index];
        return { x: xy[g * 2] * s.k + s.tx, y: xy[g * 2 + 1] * s.k + s.ty };
      },
      nodeAt: (x, y) => {
        const g = hit(x, y);
        return g < 0 ? null : view().title[g];
      },
      stats: s.stats,
    };
    return () => {
      sized.disconnect();
      themed.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("dblclick", again);
    };
  }, []);

  const edgeCount = views.full.edges.length / 2;
  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label={`${label}: ${views.full.count} ${views.full.count === 1 ? "page" : "pages"}, ${edgeCount} ${edgeCount === 1 ? "link" : "links"}`}
      data-brain-map
      data-nodes={views.full.count}
      data-edges={edgeCount}
      className={cn("block w-full touch-none select-none", className)}
    />
  );
}

