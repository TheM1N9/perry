"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { BrainGraph } from "@/convex/lib/graph";
import { useSession } from "@/lib/session";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { hrefOf } from "./brain-map";
import { GraphView } from "./graph-view";

/** A page's own small map (Obsidian's local graph): it and what it is tied to, one or two steps out. */
export function LocalMap({ id }: { id: string }) {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const [depth, setDepth] = useState(1);
  const fresh = useQuery(api.brainMap.graph, { key: dashboardKey, around: id, depth });
  // While another depth loads, the one shown stays.
  const last = useRef<BrainGraph | undefined>(undefined);
  if (fresh) last.current = fresh;
  const graph = fresh ?? last.current;
  if (!graph || graph.nodes.length <= 1) return null;
  return (
    <section aria-label="Local map" className="mt-8" data-local-map>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">Map</h2>
        <ToggleGroup value={[String(depth)]} onValueChange={(value) => { if (value[0]) setDepth(Number(value[0])); }} size="sm" spacing={0} aria-label="Steps out">
          <ToggleGroupItem value="1" className="h-6 px-2 text-xs font-normal">1 step</ToggleGroupItem>
          <ToggleGroupItem value="2" className="h-6 px-2 text-xs font-normal">2 steps</ToggleGroupItem>
        </ToggleGroup>
        <Link href={`/brain?view=map&focus=${encodeURIComponent(id)}`} className="ml-auto text-xs text-muted-foreground hover:text-foreground hover:underline underline-offset-2">Open in map</Link>
      </div>
      <GraphView graph={graph} center={id} months={false} labelAll={graph.nodes.length <= 40} label="Local map" className="h-64"
        onOpen={(node) => { if (node.id !== id) router.push(hrefOf(node)); }} />
    </section>
  );
}
