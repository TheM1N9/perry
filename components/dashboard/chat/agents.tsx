"use client";

import Link from "next/link";
import { useId } from "react";
import { BotIcon, ChevronRightIcon } from "lucide-react";
import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ChatAgent, ChatSummary } from "@/convex/dashboard";
import { tickText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { took, type Turn } from "./work";

const STATUS = { queued: "Queued", running: "Working", blocked: "Needs you", done: "Completed", failed: "Failed", cancelled: "Stopped" };

export function agentsForWork(agents: ChatAgent[], work?: Turn) {
  if (!work) return undefined;
  const matches = agents.filter((agent) => agent.runId ? work.runIds.includes(agent.runId)
    : agent.startedAt >= work.startedAt && agent.startedAt <= (work.finishedAt ?? Infinity));
  return matches.length ? matches : undefined;
}

export function AgentStatus({ agent }: { agent?: ChatSummary["agent"] }) {
  if (!agent) return <span>Agent</span>;
  const active = agent.status === "running" || agent.status === "queued";
  return <span ref={tickText((now) => `${STATUS[agent.status]}${agent.finishedAt !== undefined ? " in" : " for"} ${took(Math.max(0, (agent.finishedAt ?? now) - agent.startedAt))}`, active)} />;
}

export function AgentRow({ agent }: { agent: ChatAgent }) {
  const description = useId();
  const active = agent.status === "running" || agent.status === "queued";
  const content = <>
    <span className="relative grid size-8 shrink-0 place-items-center rounded-full border border-border/60">
      <BotIcon className="size-4 text-muted-foreground" aria-hidden />
      <span className={cn("absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-background", active ? "bg-primary motion-safe:animate-pulse" : agent.status === "done" ? "bg-success" : agent.status === "failed" ? "bg-destructive" : "bg-muted-foreground")} />
    </span>
    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{agent.title}</span>
      <span id={description} className="block truncate text-xs text-muted-foreground">{agent.text || STATUS[agent.status]}</span></span>
    <span className="nums w-14 shrink-0 text-right text-xs text-muted-foreground" aria-hidden
      ref={tickText((now) => took(Math.max(0, (agent.finishedAt ?? now) - agent.startedAt)), active)} />
    {agent.conversationId && <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
  </>;
  const className = "flex min-h-16 min-w-0 touch-manipulation items-center gap-3 rounded-lg px-2 py-2 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring";
  return agent.conversationId
    ? <Link href={`/chat/${agent.conversationId}`} className={className} data-agent={agent.id} data-agent-status={agent.status} aria-label={`Open agent: ${agent.title}. ${STATUS[agent.status]}`} aria-describedby={description}>{content}</Link>
    : <div className={className} data-agent={agent.id} data-agent-status={agent.status}>{content}</div>;
}

export function AgentRows({ agents }: { agents: ChatAgent[] }) {
  if (!agents.length) return null;
  return <div className="min-w-0" aria-label="Agents">{agents.map((agent) => <AgentRow key={agent.id} agent={agent} />)}</div>;
}

export function AgentsSurface({ conversationId }: { conversationId: Id<"conversations"> }) {
  const { dashboardKey } = useSession();
  const agents = useQuery(api.dashboard.getChatAgents, { key: dashboardKey, id: conversationId });
  return <section className="min-h-0 flex-1 overflow-y-auto p-4" data-surface="agents" aria-label="Chat agents">
    {agents === undefined ? <Skeleton className="h-16 w-full" /> : agents.length ? <AgentRows agents={agents} />
      : <div className="py-10 text-center text-sm text-muted-foreground"><BotIcon className="mx-auto mb-3 size-6" aria-hidden /><p>No agents yet</p><p className="mt-1 text-xs">Agents Perry starts in this chat appear here.</p></div>}
  </section>;
}
