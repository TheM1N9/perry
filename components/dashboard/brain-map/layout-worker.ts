import { forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";

/**
 * Brain's map lays itself out here, off the page's thread (issue #225): a
 * force layout (d3-force, ISC) where linked pages pull together and every
 * page pushes the others away. It runs in slices of a few milliseconds and
 * sends the positions after each, so the map draws from the first slice and
 * settles as it goes, and a drag or a new page is taken between slices.
 */

export type ToLayout =
  | {
    type: "init"; count: number; links: Int32Array; weights: Float32Array; positions: Float32Array; known: Uint8Array; heat: number;
    /**
     * A large map's timeline: each journal day's month (an index, or -1), how many months, and which months follow
     * which. Each month is a point the layout adds, its days held close to it and the months strung in order, so
     * a month is a tight cluster and the journal a line through time rather than a cloud.
     */
    month: Int32Array; months: number; chain: Int32Array;
    /** Where each month sits left to right: the timeline runs across the map, oldest on the left. */
    monthX: Float32Array;
  }
  | { type: "drag"; index: number; x: number; y: number }
  | { type: "release"; index: number };
export type FromLayout = { type: "tick"; positions: Float32Array; alpha: number; settled: boolean };

type Node = SimulationNodeDatum & { degree: number; at?: number };
type Link = SimulationLinkDatum<Node> & { weight: number; length?: number; loose?: boolean };

const scope = self as unknown as { onmessage: ((event: MessageEvent<ToLayout>) => void) | null; postMessage: (message: FromLayout, transfer: Transferable[]) => void };
/** Milliseconds of layout between sends: enough to move, little enough that a drag answers at once. */
const SLICE_MS = 12;
let nodes: Node[] = [];
/** The pages; anything after them is a month the layout added. */
let real = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const simulation = forceSimulation<Node>([]).stop();

function send(settled: boolean) {
  const positions = new Float32Array(real * 2);
  for (let i = 0; i < real; i++) { positions[i * 2] = nodes[i].x ?? 0; positions[i * 2 + 1] = nodes[i].y ?? 0; }
  scope.postMessage({ type: "tick", positions, alpha: simulation.alpha(), settled }, [positions.buffer]);
}

function run() {
  timer = null;
  const until = performance.now() + SLICE_MS;
  do simulation.tick(); while (performance.now() < until && simulation.alpha() > simulation.alphaMin());
  const settled = simulation.alpha() <= simulation.alphaMin();
  send(settled);
  if (!settled) timer = setTimeout(run, 0);
}
const wake = () => { if (!timer) timer = setTimeout(run, 0); };

scope.onmessage = ({ data }) => {
  if (data.type === "init") {
    real = data.count;
    nodes = Array.from({ length: data.count + data.months }, (_, i): Node => ({
      index: i, degree: 0,
      ...(i < data.count && data.known[i] ? { x: data.positions[i * 2], y: data.positions[i * 2 + 1] } : {}),
      ...(i >= data.count ? { at: data.monthX[i - data.count], x: data.monthX[i - data.count], y: 0 } : {}),
    }));
    const links: Link[] = [];
    // The timeline: a day to its month, short and strong; a month to the next, longer.
    for (let i = 0; i < data.count; i++) if (data.month[i] >= 0) links.push({ source: i, target: data.count + data.month[i], weight: 4, length: 12 });
    for (let i = 0; i < data.chain.length; i += 2) links.push({ source: data.count + data.chain[i], target: data.count + data.chain[i + 1], weight: 6, length: 90 });
    for (const link of links) { nodes[link.source as number].degree++; nodes[link.target as number].degree++; }
    for (let i = 0; i < data.links.length; i += 2) {
      const source = data.links[i];
      const target = data.links[i + 1];
      nodes[source].degree++;
      nodes[target].degree++;
      // A journal day's ties to people are many and weak, so the timeline keeps its shape and people sit by the months
      // they are in most.
      const journal = data.month[source] >= 0 || data.month[target] >= 0;
      links.push({ source, target, weight: data.weights[i / 2], ...(journal ? { loose: true } : {}) });
    }
    // A page new to the map starts beside one it is tied to, else where d3 puts it (a spiral around the middle).
    for (const link of links) {
      const a = nodes[link.source as number];
      const b = nodes[link.target as number];
      if (a.x === undefined && b.x !== undefined) { a.x = b.x! + (Math.random() - 0.5) * 20; a.y = b.y! + (Math.random() - 0.5) * 20; }
      else if (b.x === undefined && a.x !== undefined) { b.x = a.x! + (Math.random() - 0.5) * 20; b.y = a.y! + (Math.random() - 0.5) * 20; }
    }
    const big = nodes.length > 1500;
    simulation.nodes(nodes)
      .force("link", forceLink<Node, Link>(links).distance((link) => link.length ?? 30)
        .strength((link) => (link.loose ? 0.25 : 1) * Math.min(1, 0.6 + 0.1 * link.weight) / Math.min((link.source as Node).degree, (link.target as Node).degree)))
      .force("charge", forceManyBody<Node>().strength((node) => -40 - 4 * Math.sqrt(node.degree)).theta(big ? 1.5 : 0.9))
      // A weak pull to the middle keeps the map together; a page tied to nothing is pulled harder, or the push of
      // thousands of others would leave it far out, and the map zoomed out to fit it.
      .force("x", forceX<Node>((node) => node.at ?? 0).strength((node) => (node.at !== undefined ? 0.5 : node.degree ? 0.04 : 0.25)))
      .force("y", forceY<Node>(0).strength((node) => (node.degree ? 0.04 : 0.25)))
      .alphaDecay(big ? 0.045 : 0.0228)
      .alpha(data.heat)
      .alphaTarget(0);
    wake();
  } else if (data.type === "drag") {
    const node = nodes[data.index];
    if (!node) return;
    node.fx = data.x;
    node.fy = data.y;
    simulation.alphaTarget(0.25);
    if (simulation.alpha() < 0.25) simulation.alpha(0.25);
    wake();
  } else if (data.type === "release") {
    const node = nodes[data.index];
    if (node) { node.fx = null; node.fy = null; }
    simulation.alphaTarget(0);
    wake();
  }
};
