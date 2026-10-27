"use client";

import Link from "next/link";
import { FolderIcon } from "lucide-react";
import type { ChatStatus } from "@/convex/dashboard";
import type { Id } from "@/convex/_generated/dataModel";
import { ACCESS_LABELS, type Access } from "@/convex/lib/commands";
import { ENGINE_LABELS, type EngineKind } from "@/convex/lib/engines";
import { resetsText, usedNow, WARN_PERCENT, type EngineUsage } from "@/convex/lib/usage";
import { cn } from "@/lib/utils";
import { levelName } from "../composer";
import { StatusIndicator, statusLabel } from "../../status-indicator";

/** What Details says about a chat: what it runs on, how it acts, how full its context is, and how much of the engine's plan is left. */
export type ChatDetails = {
  engine?: EngineKind; model?: string; effort?: string; access?: Access; status?: ChatStatus;
  project?: { id: Id<"projects">; name: string };
  context?: { fill: number; window: number }; usage?: EngineUsage;
};

const tokens = (count: number) => count >= 1_000_000 ? `${(count / 1_000_000).toFixed(count % 1_000_000 ? 1 : 0)}M` : `${Math.round(count / 1000)}k`;

export function Details({ details }: { details?: ChatDetails }) {
  const now = Date.now();
  const used = details?.context;
  const windows = details?.usage?.limits?.windows ?? [];
  return <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 text-sm" data-surface="details">
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 text-xs" data-chat-details>
      {details?.status && <><dt className="text-muted-foreground">Status</dt><dd className="flex min-w-0 items-center justify-end gap-1.5">
        <span className="truncate">{statusLabel(details.status) ?? "Ready"}</span><StatusIndicator status={details.status} />
      </dd></>}
      {details?.project && <><dt className="text-muted-foreground">Project</dt><dd className="min-w-0 text-right">
        <Link href={`/projects/${details.project.id}`} className="inline-flex max-w-full items-center gap-1 truncate hover:underline"><FolderIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /><span className="truncate">{details.project.name}</span></Link>
      </dd></>}
      <dt className="text-muted-foreground">Engine</dt><dd className="truncate text-right">{details?.engine ? ENGINE_LABELS[details.engine] : "Not chosen"}</dd>
      <dt className="text-muted-foreground">Model</dt><dd className="truncate text-right">{details?.model || "Default"}</dd>
      <dt className="text-muted-foreground">Thinking</dt><dd className="truncate text-right">{details?.effort ? levelName(details.effort) : "Default"}</dd>
      {details?.access && <><dt className="text-muted-foreground">Access</dt><dd className={cn("truncate text-right", details.access === "full" && "text-warning")}>{ACCESS_LABELS[details.access]}</dd></>}
      {details?.usage?.limits?.plan && <><dt className="text-muted-foreground">Plan</dt><dd className="truncate text-right">{details.usage.limits.plan}</dd></>}
    </dl>
    <section aria-label="Context" data-context-used>
      <h3 className="text-xs font-medium text-muted-foreground">Context</h3>
      {used ? <>
        <div className="mt-1.5 flex items-baseline justify-between gap-2">
          <span className="font-medium nums">{Math.round(used.fill * 100)}% used</span>
          <span className="nums text-xs text-muted-foreground">{tokens(used.fill * used.window)} / {tokens(used.window)}</span>
        </div>
        <Meter value={used.fill} label="Context used" />
        <p className="mt-1.5 text-xs text-muted-foreground">Perry saves what matters to Brain before the engine compacts it.</p>
      </> : <p className="mt-1.5 text-xs text-muted-foreground">How full the context is shows after Perry's next reply.</p>}
    </section>
    {windows.length > 0 && <section aria-label="Plan usage" className="space-y-2.5" data-plan-usage>
      <h3 className="text-xs font-medium text-muted-foreground">Plan</h3>
      {windows.map((window) => {
        const percent = usedNow(window, now);
        return <div key={window.id}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span>{window.label}</span>
            <span className="nums text-muted-foreground">{Math.round(percent)}%{resetsText(window, now) ? ` · ${resetsText(window, now)}` : ""}</span>
          </div>
          <Meter value={percent / 100} label={`${window.label} plan used`} tone={percent >= 100 ? "out" : percent >= WARN_PERCENT ? "low" : "ok"} />
        </div>;
      })}
    </section>}
  </div>;
}

function Meter({ value, label, tone = "ok" }: { value: number; label: string; tone?: "ok" | "low" | "out" }) {
  const percent = Math.max(0, Math.min(100, value * 100));
  return <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
    <div className={cn("h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none", tone === "out" ? "bg-destructive" : tone === "low" ? "bg-warning" : "bg-primary")} style={{ width: `${percent}%` }} />
  </div>;
}
