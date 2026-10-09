"use client";

import { useMemo } from "react";
import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { EngineView } from "@/convex/engines";
import { isRunnable, type EngineKind } from "@/convex/lib/engines";
import { useSession } from "@/lib/session";
import { RadioGroup, RadioGroupCard } from "@/components/ui/radio-group";
import { StatusBadge } from "./common";

/** An engine as the owner chooses among them: how it stands on the computers that report it. */
export type EngineChoiceItem = {
  kind: EngineKind;
  label: string;
  /** Installed and signed in on an online computer, and not too old for Perry: it can answer now. */
  ready: boolean;
  /** One line on how it stands: the account it is signed in with, or what it is missing and where. */
  detail: string;
};

/** How far an engine is from answering on a computer: 0 ready, then signed out, then missing or too old, then offline. */
function distance(engine: EngineView, online: boolean): number {
  if (!online) return 4;
  if (!engine.installed || engine.update?.need === "required") return 3;
  return engine.signedIn ? 0 : 1;
}

function describe(engine: EngineView, computer: string, online: boolean, several: boolean): string {
  const where = several ? ` on ${computer}` : "";
  if (!online) return `On ${computer}, which is offline.`;
  if (!engine.installed) return `Not installed${where}.`;
  // Antigravity is Google's server, downloaded when it is turned on: until then there is nothing to sign in to.
  if (engine.kind === "antigravity" && !engine.signedIn) return `Experimental. Not turned on${where} yet; Settings → Engines turns it on.`;
  if (engine.update?.need === "required") return `${engine.update.version}${where} is too old for Perry; it needs ${engine.update.minimum} or newer.`;
  if (!engine.signedIn) return `Installed${where}, not signed in.`;
  const plan = engine.auth.plan ? ` ${engine.auth.plan[0].toUpperCase()}${engine.auth.plan.slice(1)}` : "";
  return `Signed in${where} with ${engine.auth.label ?? "an account"}${plan}${engine.version ? ` · ${engine.version}` : ""}.`;
}

/**
 * The engines the owner can choose as Perry's default, from what the
 * connected computers report, each at its best: ready ones first, then those
 * a sign-in away, then the rest, by name within each. No order favours one
 * engine over another. Undefined while loading.
 */
export function useEngineChoices(): EngineChoiceItem[] | undefined {
  const { dashboardKey } = useSession();
  const computers = useQuery(api.engines.list, { key: dashboardKey });
  return useMemo(() => {
    if (!computers) return undefined;
    const best = new Map<EngineKind, { item: EngineChoiceItem; rank: number }>();
    for (const computer of computers) {
      for (const engine of computer.engines) {
        if (!isRunnable(engine.kind)) continue;
        const rank = distance(engine, computer.online);
        if ((best.get(engine.kind)?.rank ?? Infinity) <= rank) continue;
        best.set(engine.kind, { rank, item: { kind: engine.kind, label: engine.label, ready: rank === 0, detail: describe(engine, computer.name, computer.online, computers.length > 1) } });
      }
    }
    return [...best.values()].sort((a, b) => a.rank - b.rank || a.item.label.localeCompare(b.item.label)).map(({ item }) => item);
  }, [computers]);
}

/** Choosing Perry's default engine, as cards, each saying how that engine stands. */
export function EngineChoice({ engines, value, onChange, disabled, current }: {
  engines: EngineChoiceItem[];
  value: EngineKind | undefined;
  onChange: (engine: EngineKind) => void;
  disabled?: boolean;
  /** The default as it is saved, marked as such. */
  current?: EngineKind;
}) {
  return (
    <RadioGroup aria-label="Default engine" value={value ?? null} disabled={disabled} onValueChange={(next) => onChange(next as EngineKind)} className="gap-2 sm:grid-cols-2">
      {engines.map((engine) => (
        <RadioGroupCard key={engine.kind} value={engine.kind} aria-label={engine.label}>
          <span className="grid min-w-0 gap-0.5">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-medium">{engine.label}</span>
              {engine.kind === current && <StatusBadge>Default</StatusBadge>}
              {!engine.ready && <StatusBadge tone="warning">Not ready</StatusBadge>}
            </span>
            <span className="text-sm text-pretty text-muted-foreground">{engine.detail}</span>
          </span>
        </RadioGroupCard>
      ))}
    </RadioGroup>
  );
}
