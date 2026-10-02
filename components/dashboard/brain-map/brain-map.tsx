"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { SearchIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { BrainGraph, MapKind, MapNode } from "@/convex/lib/graph";
import { noteHref } from "@/convex/lib/notes";
import { useSession } from "@/lib/session";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EmptyState } from "../common";
import { GraphView, KIND_COLOR } from "./graph-view";

/**
 * Brain as a map (issue #225), Obsidian's graph view: every page a dot, every
 * tie a line. Hover names a page and lights its neighbours, a click opens it,
 * search finds and centres one, and filters narrow it by kind, project, time
 * and whether it is tied to anything.
 */

export const KIND_LABEL: Record<MapKind, string> = {
  about: "About me", remember: "To remember", journal: "Journal", journey: "Journeys", person: "People", page: "Pages", chat: "Chats", project: "Projects",
};
const KINDS = Object.keys(KIND_LABEL) as MapKind[];
const DAY = 86_400_000;
const TIMES = [
  { value: "all", label: "Any time", days: 0 },
  { value: "week", label: "Past week", days: 7 },
  { value: "month", label: "Past month", days: 31 },
  { value: "year", label: "Past year", days: 366 },
] as const;
type Time = (typeof TIMES)[number]["value"];

/** Where a node opens: a page in Brain, a project on its page. */
export const hrefOf = (node: MapNode) => (node.kind === "project" ? `/projects/${node.id}` : noteHref(node.id));

/** Which nodes the filters leave. */
function shownBy(graph: BrainGraph, filters: { kinds: MapKind[]; project: string; time: Time; orphans: boolean }): Uint8Array {
  const n = graph.nodes.length;
  const keep = new Uint8Array(n);
  const since = filters.time === "all" ? 0 : Date.now() - TIMES.find((item) => item.value === filters.time)!.days * DAY;
  const kinds = new Set(filters.kinds);
  for (let i = 0; i < n; i++) {
    const node = graph.nodes[i];
    if (!kinds.has(node.kind)) continue;
    if (since && node.kind !== "project" && node.at < since) continue;
    if (filters.project === "none" && node.projectId) continue;
    keep[i] = 1;
  }
  // In a project: its pages, and what they are tied to (the people they mention, pages they link to).
  if (filters.project !== "all" && filters.project !== "none") {
    const inside = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (graph.nodes[i].projectId === filters.project) inside[i] = 1;
    const near = new Uint8Array(n);
    for (const [a, b] of graph.edges) {
      if (inside[a] && graph.nodes[b].kind !== "project") near[b] = 1;
      if (inside[b] && graph.nodes[a].kind !== "project") near[a] = 1;
    }
    for (let i = 0; i < n; i++) keep[i] = keep[i] && (inside[i] || near[i]) ? 1 : 0;
  }
  if (!filters.orphans) {
    const tied = new Uint8Array(n);
    for (const [a, b] of graph.edges) if (keep[a] && keep[b]) { tied[a] = 1; tied[b] = 1; }
    for (let i = 0; i < n; i++) keep[i] = keep[i] && tied[i] ? 1 : 0;
  }
  return keep;
}

export function BrainMap() {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const graph = useQuery(api.brainMap.graph, { key: dashboardKey });
  const [kinds, setKinds] = useState<MapKind[]>(KINDS);
  const [project, setProject] = useState("all");
  const [time, setTime] = useState<Time>("all");
  const [orphans, setOrphans] = useState(true);
  const [search, setSearch] = useState("");
  const [focus, setFocus] = useState<string | null>(params.get("focus"));
  const [open, setOpen] = useState(false);

  const visible = useMemo(() => (graph ? shownBy(graph, { kinds, project, time, orphans }) : undefined), [graph, kinds, project, time, orphans]);
  const needle = search.trim().toLocaleLowerCase();
  const found = useMemo(() => {
    if (!graph || !needle) return [];
    return graph.nodes.map((node, i) => ({ node, i, at: node.title.toLocaleLowerCase().indexOf(needle) }))
      .filter((hit) => hit.at >= 0 && visible?.[hit.i])
      .sort((a, b) => Number(a.at !== 0) - Number(b.at !== 0) || a.node.title.length - b.node.title.length)
      .slice(0, 8);
  }, [graph, needle, visible]);
  const pick = (node: MapNode) => { setFocus(node.id); setSearch(node.title); setOpen(false); };

  const projectItems = useMemo(() => [
    { value: "all", label: "All projects" }, { value: "none", label: "No project" },
    ...(graph?.projects ?? []).map((item) => ({ value: item.id, label: item.name })),
  ], [graph?.projects]);
  const count = visible ? visible.reduce((sum, on) => sum + on, 0) : 0;

  return (
    <section aria-label="Brain map" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <InputGroup className="h-8">
            <InputGroupAddon><SearchIcon /></InputGroupAddon>
            <InputGroupInput type="search" aria-label="Find in map" placeholder="Find a page" value={search} autoComplete="off"
              role="combobox" aria-expanded={open && found.length > 0} aria-controls="brain-map-found"
              onChange={(event) => { setSearch(event.target.value); setOpen(true); }}
              onFocus={() => setOpen(true)}
              onBlur={() => window.setTimeout(() => setOpen(false), 150)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && found[0]) { event.preventDefault(); pick(found[0].node); }
                if (event.key === "Escape") { setSearch(""); setFocus(null); }
              }} />
            {search && <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" aria-label="Clear" onClick={() => { setSearch(""); setFocus(null); }}><XIcon /></InputGroupButton></InputGroupAddon>}
          </InputGroup>
          {open && found.length > 0 && (
            <ul id="brain-map-found" role="listbox" aria-label="Pages found" className="absolute inset-x-0 top-9 z-20 max-h-72 overflow-auto rounded-lg bg-popover p-1 text-sm shadow-float ring-1 ring-foreground/10">
              {found.map(({ node }) => (
                <li key={node.id} role="option" aria-selected={node.id === focus}>
                  <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent" onMouseDown={(event) => event.preventDefault()} onClick={() => pick(node)} data-found-node={node.id}>
                    <Dot kind={node.kind} />
                    <span className="min-w-0 flex-1 truncate">{node.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{KIND_LABEL[node.kind]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Select items={projectItems} value={project} onValueChange={(value) => setProject(value ?? "all")}>
          <SelectTrigger aria-label="Project" size="sm"><SelectValue /></SelectTrigger>
          <SelectContent>{projectItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
        </Select>
        <Select items={TIMES.map(({ value, label }) => ({ value, label }))} value={time} onValueChange={(value) => setTime((value as Time | null) ?? "all")}>
          <SelectTrigger aria-label="Time" size="sm"><SelectValue /></SelectTrigger>
          <SelectContent>{TIMES.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch size="sm" checked={orphans} onCheckedChange={setOrphans} aria-label="Pages with no links" />
          Unlinked
        </label>
        <span className="ml-auto text-xs text-muted-foreground nums" data-map-count>{graph ? `${count} of ${graph.nodes.length}` : ""}</span>
      </div>
      <ToggleGroup multiple value={kinds} onValueChange={(value) => setKinds(value as MapKind[])} size="sm" spacing={1} aria-label="Kinds of page" className="flex-wrap">
        {KINDS.map((kind) => (
          <ToggleGroupItem key={kind} value={kind} data-kind={kind} className="gap-1.5 font-normal aria-[pressed=false]:text-muted-foreground aria-[pressed=false]:[&>span]:opacity-30">
            <Dot kind={kind} />{KIND_LABEL[kind]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {graph === undefined ? <Skeleton className="h-[min(70dvh,720px)] min-h-96 w-full rounded-xl" /> : graph.nodes.length === 0 ? (
        <EmptyState title="Nothing to map yet" />
      ) : (
        <GraphView
          graph={graph} visible={visible} focus={focus} label="Brain map" className="h-[min(70dvh,720px)] min-h-96"
          onOpen={(node) => router.push(hrefOf(node))}
        />
      )}
    </section>
  );
}

/** A kind's colour, as the map draws it. */
export function Dot({ kind }: { kind: MapKind }) {
  const square = kind === "project";
  return <span aria-hidden className={square ? "size-2 shrink-0 rounded-[2px]" : "size-2 shrink-0 rounded-full"} style={{ background: `var(${KIND_COLOR[kind]})` }} />;
}
