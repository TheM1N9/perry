"use client";

import Link from "next/link";
import { CalendarIcon, MicIcon, MonitorIcon, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useAction, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { describe } from "@/convex/lib/shortcuts";
import { errorText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";

const STORAGE = "perry.nextStep.dismissed";
type Step = { id: string; icon: LucideIcon; title: string; detail: ReactNode; action?: ReactNode };

/**
 * A new chat suggests one next step, the most useful thing not yet done, never
 * a row of them: put the pet on the desktop, try talking to it, connect a
 * calendar. "Not now" moves on to the next one, and it stays gone.
 */
export function NextStep({ assistant }: { assistant: string }) {
  const { dashboardKey: key } = useSession();
  const pet = useQuery(api.pet.status, { key });
  const shortcuts = useQuery(api.dashboard.getShortcuts, { key });
  const calendars = useQuery(api.meetings.recommendations, { key });
  const turnOn = useAction(api.pet.turnOn);
  const [dismissed, setDismissed] = useState<string[] | null>(null);
  useEffect(() => {
    try { setDismissed(JSON.parse(window.localStorage.getItem(STORAGE) ?? "[]") as string[]); } catch { setDismissed([]); }
  }, []);
  if (!pet || !shortcuts || !calendars || !dismissed) return null;

  const mac = /Mac/.test(navigator.platform);
  const working = pet.setup?.state === "working";
  const steps: Step[] = [
    ...(!pet.running ? [{
      id: "pet", icon: MonitorIcon, title: `Put ${assistant} on your desktop`, detail: "Ask for things from any app, without opening this page.",
      action: <Button size="sm" variant="outline" disabled={working} onClick={() => void turnOn({ key }).catch((cause) => toast.error(errorText(cause)))}>{working ? "Getting ready…" : "Turn on"}</Button>,
    }] : []),
    ...(pet.running && !pet.heardVoice ? [{
      id: "talk", icon: MicIcon, title: `Talk to ${assistant}`, detail: <>Hold <Kbd>{describe(shortcuts.shortcuts.talk, mac)}</Kbd> anywhere and say hi.</>,
    }] : []),
    ...(!calendars.calendar?.sources.length ? [{
      id: "calendar", icon: CalendarIcon, title: "Connect your calendar", detail: "Get notes for your meetings without having to remember.",
      action: <Button size="sm" variant="outline" nativeButton={false} render={<Link href="/apps/connectors" />}>Connect</Button>,
    }] : []),
  ];
  const step = steps.find((item) => !dismissed.includes(item.id));
  if (!step) return null;
  const Icon = step.icon;
  const notNow = () => {
    const next = [...dismissed, step.id];
    setDismissed(next);
    window.localStorage.setItem(STORAGE, JSON.stringify(next));
  };
  return (
    <div className="mt-6 flex w-full max-w-md items-center gap-3 rounded-xl border bg-card p-3 text-left">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft text-primary"><Icon className="size-4" aria-hidden /></span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{step.title}</p>
        <p className="text-xs text-pretty text-muted-foreground">{step.detail}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {step.action}
        <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={notNow}>Not now</Button>
      </div>
    </div>
  );
}
