"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronRightIcon, MessageSquareIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { RunView, SpanView } from "@/convex/dashboard";
import { plural } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CopyButton, EmptyState, ListSkeleton, Page, RelativeTime, StatusBadge, useSearchParam, type Tone } from "../common";

/** Runs shown at a time; the rest are a click away. */
const PAGE = 20;

const duration = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

const RUN_STATUS: Record<string, { tone: Tone; label: string }> = {
  ok: { tone: "success", label: "Completed" },
  running: { tone: "info", label: "Running" },
  error: { tone: "danger", label: "Failed" },
  rejected: { tone: "warning", label: "Rejected" },
};
const STATUS_FILTERS = [
  { value: "all", label: "Every status" },
  { value: "ok", label: "Completed" },
  { value: "running", label: "Running" },
  { value: "error", label: "Failed" },
  { value: "rejected", label: "Rejected" },
];
const SPAN_KINDS: Record<SpanView["kind"], string> = {
  command: "shell", fileChange: "files", mcpToolCall: "tool", dynamicToolCall: "tool", webSearch: "search", imageGeneration: "image", reasoning: "thinking",
};

/** Every run: what it was asked, which tools it used, what it cost, and where it failed. The messages stay in the chat. */
export function Activity() {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useSearchParam("session", "all");
  const sessionId = session === "all" ? "" : session;
  const [status, setStatus] = useSearchParam("status", "all");
  const [shown, setShown] = useState(PAGE);
  const sessions = useQuery(api.dashboard.listActivitySessions, { key: dashboardKey });
  const runs = useQuery(api.dashboard.listRuns, { key: dashboardKey, conversationId: (sessionId || undefined) as Id<"conversations"> | undefined });
  useEffect(() => setShown(PAGE), [sessionId, status]);
  const visible = runs?.filter((run) => status === "all" || run.status === status) ?? [];
  const errors = visible.filter((run) => run.status === "error").length;
  const tokens = visible.reduce((total, run) => total + (run.totalTokens ?? 0), 0);
  const filtered = Boolean(sessionId) || status !== "all";
  const clear = () => router.replace(pathname, { scroll: false });
  const sessionItems = [{ value: "all", label: "Every chat" }, ...(sessions ?? []).map((session) => ({ value: session.id, label: `${session.title}${session.channel === "telegram" ? " · Telegram" : ""}` }))];

  return (
    <Page title="Activity" description="Every run, with its tools, tokens, timing and errors. Newest first." wide>
      <dl className="mb-6 flex flex-wrap divide-x rounded-xl border bg-card" aria-label="Summary">
        {[
          { label: "Runs", value: visible.length.toLocaleString() },
          { label: "Failed", value: errors.toLocaleString(), alert: errors > 0 },
          { label: "Tokens", value: tokens.toLocaleString() },
        ].map((stat) => (
          <div key={stat.label} className="min-w-28 flex-1 px-5 py-4">
            <dt className="text-xs text-muted-foreground">{stat.label}</dt>
            <dd className={cn("nums mt-1 text-2xl font-semibold tracking-tight", stat.alert && "text-destructive")}>{runs === undefined ? "–" : stat.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select items={sessionItems} value={session} onValueChange={(value) => setSession(value ?? "all")}>
          <SelectTrigger aria-label="Chat" className="max-w-72 min-w-44"><SelectValue /></SelectTrigger>
          <SelectContent alignItemWithTrigger={false} align="start">
            {sessionItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select items={STATUS_FILTERS} value={status} onValueChange={(value) => setStatus(value ?? "all")}>
          <SelectTrigger aria-label="Status" className="min-w-36"><SelectValue /></SelectTrigger>
          <SelectContent alignItemWithTrigger={false} align="start">
            {STATUS_FILTERS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
          </SelectContent>
        </Select>
        {filtered && <Button variant="ghost" size="sm" onClick={clear}>Clear filters</Button>}
      </div>

      {runs === undefined && <ListSkeleton rows={4} />}
      {runs && visible.length === 0 && (filtered
        ? <EmptyState title="No runs match" action={<Button variant="outline" size="sm" onClick={clear}>Clear filters</Button>} />
        : <EmptyState title="No runs yet">Every message Perry answers shows up here, with its tools, tokens and timing.</EmptyState>)}
      {visible.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card" aria-label="Runs">
          {visible.slice(0, shown).map((run) => <RunRow key={run.id} run={run} />)}
        </ul>
      )}
      {visible.length > shown && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" size="sm" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, visible.length - shown)} more of {visible.length - shown}</Button>
        </div>
      )}
    </Page>
  );
}

function RunRow({ run }: { run: RunView }) {
  const [open, setOpen] = useState(false);
  const state = RUN_STATUS[run.status] ?? { tone: "neutral" as Tone, label: run.status };
  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex w-full items-start gap-3 px-4 py-3.5 text-left hover:bg-muted/40">
          <ChevronRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate font-medium">{run.chatTitle}</span>
              {run.channel === "telegram" && <StatusBadge>Telegram</StatusBadge>}
            </span>
            <span className="mt-0.5 block truncate text-sm text-muted-foreground">{run.prompt}</span>
            <span className="nums mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <RelativeTime at={run.startedAt} />
              {run.model && <span className="font-mono">{run.model}</span>}
              {typeof run.steps === "number" && <span>{plural(run.steps, "step")}</span>}
              {typeof run.durationMs === "number" && <span>{duration(run.durationMs)}</span>}
              {typeof run.totalTokens === "number" && <span>{run.totalTokens.toLocaleString()} tokens</span>}
            </span>
          </span>
          <StatusBadge tone={state.tone} pulse={run.status === "running"}>{state.label}</StatusBadge>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-5 border-t bg-muted/20 px-4 py-4 sm:pl-11">
            {run.error && <pre className="max-h-48 overflow-auto rounded-lg border border-destructive/30 bg-destructive/5 p-3 font-mono text-xs whitespace-pre-wrap text-destructive">{run.error}</pre>}
            {run.toolCalls && run.toolCalls.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">Tools</h4>
                <div className="flex flex-wrap gap-1.5">{run.toolCalls.map((tool, index) => <code key={`${tool}-${index}`} className="rounded-md border bg-background px-1.5 py-0.5 font-mono text-xs">{tool}</code>)}</div>
              </div>
            )}
            <div>
              <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">Trace</h4>
              {open && <Trace run={run} />}
            </div>
            <div>
              <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">Prompt</h4>
              <p className="max-h-60 overflow-auto rounded-lg border bg-background p-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{run.prompt}</p>
            </div>
            {run.usage?.inputTokens !== undefined && (
              <p className="nums text-xs text-muted-foreground">
                {run.usage.inputTokens.toLocaleString()} in · {(run.usage.cachedInputTokens ?? 0).toLocaleString()} cached · {(run.usage.outputTokens ?? 0).toLocaleString()} out
                {run.usage.reasoningTokens ? ` (${run.usage.reasoningTokens.toLocaleString()} reasoning)` : ""}
              </p>
            )}
            <dl className="grid gap-1 text-xs">
              {([["Session", run.sessionId], ["Run", run.id], ...(run.threadId ? [["Thread", run.threadId]] : [])] as Array<[string, string]>).map(([label, value]) => (
                <div key={label} className="flex items-center gap-2">
                  <dt className="w-14 text-muted-foreground">{label}</dt>
                  <dd className="truncate font-mono">{value}</dd>
                  <CopyButton value={value} label={`Copy ${label.toLowerCase()} ID`} size="icon-xs" />
                </div>
              ))}
            </dl>
            {run.channel === "web" && (
              <Button variant="outline" size="sm" render={<Link href={`/chat/${run.sessionId}`} />}><MessageSquareIcon />Open chat</Button>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/**
 * What Codex did in a run, as a timeline from its first span to its last. Span
 * times come from the runner's clock, which can be off the server's, so the
 * run's own times are not mixed in.
 */
function Trace({ run }: { run: RunView }) {
  const { dashboardKey } = useSession();
  const spans = useQuery(api.dashboard.runTrace, { key: dashboardKey, runId: run.id as Id<"runs"> });
  if (spans === undefined) return <p className="text-sm text-muted-foreground" role="status">Loading…</p>;
  if (spans.length === 0) return <p className="text-sm text-muted-foreground">Nothing was traced for this run.</p>;
  const origin = Math.min(...spans.map((span) => span.startedAt));
  const end = Math.max(...spans.map((span) => span.startedAt + (span.durationMs ?? Date.now() - span.startedAt)));
  const total = Math.max(1, end - origin);
  const percent = (ms: number) => Math.min(100, Math.max(0, (ms / total) * 100));
  return (
    <ol className="space-y-1" aria-label="Trace">
      {spans.map((span) => {
        const left = percent(span.startedAt - origin);
        const width = Math.max(0.8, Math.min(100 - left, percent(span.durationMs ?? Date.now() - span.startedAt)));
        const bar = span.status === "error" ? "bg-destructive" : span.status === "declined" ? "bg-warning" : span.status === "running" ? "bg-primary motion-safe:animate-pulse" : "bg-primary/70";
        return (
          <li key={span.id}>
            <Collapsible disabled={!span.input && !span.output}>
              <CollapsibleTrigger className="group grid w-full grid-cols-[minmax(0,14rem)_1fr_4.5rem] items-center gap-3 rounded-md px-1 py-1 text-left text-xs enabled:hover:bg-muted">
                <span className="flex min-w-0 items-center gap-1.5" title={span.name}>
                  <span className="shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground uppercase">{SPAN_KINDS[span.kind]}</span>
                  <span className="truncate">{span.name}</span>
                </span>
                <span className="relative h-1.5 rounded-full bg-muted" aria-hidden><span className={cn("absolute inset-y-0 rounded-full", bar)} style={{ left: `${left}%`, width: `${width}%` }} /></span>
                <span className="nums text-right text-muted-foreground">
                  {span.status === "running" ? "running" : duration(span.durationMs ?? 0)}
                  {span.status !== "ok" && span.status !== "running" && <span className="sr-only"> ({span.status})</span>}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="my-1 grid gap-2 pl-1">
                  {span.input && <pre className="max-h-48 overflow-auto rounded-md border bg-background p-2 font-mono text-[11px] whitespace-pre-wrap">{span.input}</pre>}
                  {span.output && <pre className="max-h-48 overflow-auto rounded-md border bg-background p-2 font-mono text-[11px] whitespace-pre-wrap">{span.output}</pre>}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </li>
        );
      })}
      <li className="nums pt-1 text-right text-xs text-muted-foreground">Total {duration(total)}</li>
    </ol>
  );
}
