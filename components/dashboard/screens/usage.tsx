"use client";

import Link from "next/link";
import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { ENGINE_LABELS } from "@/convex/lib/engines";
import { resetsText, standing, usedNow, WARN_PERCENT, type PlanWindow } from "@/convex/lib/usage";
import type { EngineOverview, ShareItem } from "@/convex/usage";
import { ago, fullDate, plural, timeOf, useNow } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import { ChannelIcon, CommandLine, EmptyState, List, ListSkeleton, Section, StatusBadge, type Tone } from "../common";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
/** "1.2M tokens", "840 tokens". */
export const tokens = (count: number) => `${compact.format(count)} ${count === 1 ? "token" : "tokens"}`;

const KINDS: Record<ShareItem["kind"], string> = { chat: "Chat", contact: "With someone", job: "Schedule", task: "Background task" };

/**
 * Settings → Usage: how much of each engine's subscription is used and what
 * is left, as the engines report it, and Perry's own share of it.
 */
export function Usage() {
  const { dashboardKey } = useSession();
  const overview = useQuery(api.usage.overview, { key: dashboardKey });
  const now = useNow(30_000);
  return (
    <>
      <Section title="Your plans" description={`How much of each engine's plan is used, counting all your use of it, and when each limit starts again. Perry warns in the chat and on the pet from ${WARN_PERCENT}%.`}>
        {overview === undefined && <ListSkeleton rows={2} />}
        {overview && overview.computers === 0 && (
          <EmptyState title="No computer connected" action={<div className="w-[min(360px,80vw)]"><CommandLine>perry start</CommandLine></div>}>
            Start Perry on the computer that will do the work, then sign in to an engine.
          </EmptyState>
        )}
        {overview && overview.computers > 0 && (
          <List label="Plans">
            {overview.engines.map((engine) => <PlanRow key={engine.kind} engine={engine} now={now} />)}
          </List>
        )}
      </Section>
      <Section title="Perry's share this week"
        description="Tokens Perry's chats, schedules and background tasks used in the last 7 days, as each engine reported them reply by reply.">
        {overview === undefined && <ListSkeleton rows={3} />}
        {overview && <Share engines={overview.engines} items={overview.items} now={now} />}
      </Section>
    </>
  );
}

/** One engine's plan: each of its windows, how full, when it resets, and Perry's part of it. */
function PlanRow({ engine, now }: { engine: EngineOverview; now: number }) {
  const limits = engine.usage?.limits;
  const { level, hit } = standing(engine.usage, now);
  const state: { tone: Tone; label: string } | null = level === "out" ? { tone: "danger", label: "Used up" }
    : level === "low" ? { tone: "warning", label: "Running low" }
    : limits?.windows.length ? { tone: "success", label: "Room left" } : null;
  const plan = engine.plan ? `${engine.plan[0].toUpperCase()}${engine.plan.slice(1)}` : null;
  return (
    <li className="px-4 py-4" aria-label={`${engine.label} plan`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{engine.label}</h3>
        {plan && <StatusBadge>{plan}</StatusBadge>}
        {!engine.signedIn && <StatusBadge tone="neutral">{engine.installed ? "Not signed in" : "Not set up"}</StatusBadge>}
        {state && <StatusBadge tone={state.tone}>{state.label}</StatusBadge>}
        {limits && <span className="ml-auto text-xs text-muted-foreground">Read {ago(limits.at, now)}</span>}
      </div>
      {engine.reportsLimits && limits && limits.windows.length > 0 && (
        <div className="mt-3 grid gap-3">
          {limits.windows.map((window) => <WindowRow key={window.id} window={window} share={engine.share.windows[window.id]} now={now} />)}
        </div>
      )}
      {engine.reportsLimits && !limits?.windows.length && (
        <p className="mt-1 text-sm text-muted-foreground">
          {engine.signedIn ? `Waiting for ${engine.label} to report its limits…` : `${engine.installed ? "Sign in to" : "Set up"} ${engine.label} under General to see its limits.`}
        </p>
      )}
      {hit && (
        <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-pretty text-destructive" role="alert">
          {engine.label} refused a reply for your plan&apos;s limit at {new Date(hit.at).toDateString() === new Date(now).toDateString() ? timeOf(hit.at) : fullDate(hit.at)}: “{hit.message.slice(0, 300)}”
        </p>
      )}
      <p className="mt-2 text-sm text-pretty text-muted-foreground">{engine.note}</p>
      {engine.share.week.turns > 0 && (
        <p className="mt-1 text-sm text-muted-foreground">
          Perry this week: {engine.tokens === "none" ? plural(engine.share.week.turns, "reply", "replies") : `${tokens(engine.share.week.tokens)} over ${plural(engine.share.week.turns, "reply", "replies")}`}.
        </p>
      )}
    </li>
  );
}

function WindowRow({ window, share, now }: { window: PlanWindow; share?: { tokens: number; turns: number }; now: number }) {
  const used = usedNow(window, now);
  const resets = resetsText(window, now);
  const bar = used >= 100 ? "[&_[data-slot=progress-indicator]]:bg-destructive" : used >= WARN_PERCENT ? "[&_[data-slot=progress-indicator]]:bg-warning" : "";
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-medium">{window.label}</span>
        <span className={cn("nums", used >= 100 ? "font-medium text-destructive" : used >= WARN_PERCENT ? "font-medium text-warning" : "text-muted-foreground")}>
          {Math.round(used)}% used · {Math.max(0, 100 - Math.round(used))}% left{resets ? ` · ${resets}` : window.resetsAt ? " · reset since" : ""}
        </span>
      </div>
      <Progress value={used} aria-label={`${window.label}: ${Math.round(used)}% used`} className={cn("mt-1.5", bar)} />
      {share && (
        <p className="mt-1 text-xs text-muted-foreground">
          Perry in this window: {share.turns ? `${tokens(share.tokens)} over ${plural(share.turns, "reply", "replies")}` : "nothing yet"}
        </p>
      )}
    </div>
  );
}

/** Perry's own use: each engine's total this week, then what used the most. */
function Share({ engines, items, now }: { engines: EngineOverview[]; items: ShareItem[]; now: number }) {
  const used = engines.filter((engine) => engine.share.week.turns > 0);
  if (!used.length) {
    return <EmptyState title="Nothing yet this week">What Perry&apos;s replies, schedules and tasks use shows here once they run.</EmptyState>;
  }
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        {used.map((engine) => (
          <div key={engine.kind} className="rounded-xl border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">{engine.label}</p>
            <p className="mt-0.5 text-lg font-semibold nums">{engine.tokens === "none" ? "—" : compact.format(engine.share.week.tokens)}</p>
            <p className="text-xs text-muted-foreground">{engine.tokens === "none" ? `${plural(engine.share.week.turns, "reply", "replies")}; it reports no tokens` : `tokens over ${plural(engine.share.week.turns, "reply", "replies")}`}</p>
          </div>
        ))}
      </div>
      <List label="What used the most">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
            {item.channel !== "deleted" && <ChannelIcon channel={item.channel} className="size-4 shrink-0 text-muted-foreground" />}
            <div className="min-w-0 flex-1">
              {item.channel === "deleted"
                ? <p className="truncate text-sm font-medium text-muted-foreground">{item.title}</p>
                : <Link href={`/chat/${item.id}`} className="block truncate text-sm font-medium hover:underline">{item.title}</Link>}
              <p className="text-xs text-muted-foreground">
                {KINDS[item.kind]} · {item.engines.map((kind) => ENGINE_LABELS[kind]).join(", ")} · last {ago(item.lastAt, now)}
              </p>
            </div>
            <div className="text-right text-sm nums">
              <p className="font-medium">{item.tokens ? tokens(item.tokens) : "No token count"}</p>
              <p className="text-xs text-muted-foreground">{plural(item.turns, "reply", "replies")}</p>
            </div>
          </li>
        ))}
      </List>
    </>
  );
}
