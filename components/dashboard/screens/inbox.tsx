"use client";

import Link from "next/link";
import { AlarmClockIcon, CircleHelpIcon, ExternalLinkIcon, EyeIcon, MessageSquareIcon, OctagonXIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { InboxItem } from "@/convex/dashboard";
import { useNow } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ApprovalCard } from "../approval-card";
import { ActionButton, EmptyState, ListSkeleton, Page, RelativeTime, Section, attempt } from "../common";

type Dismissable = Exclude<InboxItem, { kind: "question" }>;

const KIND: Record<InboxItem["kind"], { label: string; icon: typeof CircleHelpIcon; tone: string }> = {
  question: { label: "A plan needs your answer", icon: CircleHelpIcon, tone: "text-warning" },
  "task-failed": { label: "A plan failed", icon: OctagonXIcon, tone: "text-destructive" },
  "job-error": { label: "A schedule failed", icon: OctagonXIcon, tone: "text-destructive" },
  "job-result": { label: "New from a schedule", icon: AlarmClockIcon, tone: "text-primary" },
  watch: { label: "A watch fired", icon: EyeIcon, tone: "text-primary" },
};

/**
 * Everything waiting on you, in one place: what a computer wants to do, the
 * questions plans are stuck on, what failed, and news from schedules and
 * watches. Each goes once it is answered, opened or dismissed.
 */
export function Inbox() {
  const { dashboardKey } = useSession();
  const approvals = useQuery(api.approvals.pending, { key: dashboardKey });
  const inbox = useQuery(api.dashboard.getInbox, { key: dashboardKey });
  const dismiss = useMutation(api.dashboard.dismissInbox).withOptimisticUpdate((store, args) => {
    const list = store.getQuery(api.dashboard.getInbox, { key: args.key });
    if (list) store.setQuery(api.dashboard.getInbox, { key: args.key }, list.filter((item) => !args.items.some((gone) => gone.kind === item.kind && gone.id === item.id)));
  });
  const now = useNow(1000);
  const live = (approvals ?? []).filter((item) => item.expiresAt > now);
  const dismissable = (inbox ?? []).filter((item): item is Dismissable => item.kind !== "question");
  const clear = (items: Dismissable[]) => dismiss({ key: dashboardKey, items: items.map(({ kind, id }) => ({ kind, id })) });

  const loading = approvals === undefined || inbox === undefined;
  const empty = !loading && live.length === 0 && inbox.length === 0;

  return (
    <Page title="Needs you" description="What's waiting on you. Answer here, or in the chat it came from."
      actions={dismissable.length > 1 && <ActionButton variant="outline" size="sm" action={() => clear(dismissable)} success="Cleared.">Clear all</ActionButton>}>
      {loading && <ListSkeleton rows={2} />}
      {empty && <EmptyState mascot title="You're all caught up">Approvals, questions and anything that failed land here, as it happens.</EmptyState>}
      {live.length > 0 && (
        <Section title="Approvals" description="A computer is waiting to do this. Unanswered requests are declined after ten minutes.">
          <div className="space-y-3">{live.map((approval) => <ApprovalCard key={approval.id} approval={approval} now={now} />)}</div>
        </Section>
      )}
      {inbox && inbox.length > 0 && (
        <Section title="Updates">
          <ul className="divide-y overflow-hidden rounded-xl border bg-card" aria-label="Updates">
            {inbox.map((item) => (
              <InboxRow key={`${item.kind}-${item.id}`} item={item}
                onDismiss={item.kind === "question" ? undefined : () => void attempt(() => clear([item]))} />
            ))}
          </ul>
        </Section>
      )}
    </Page>
  );
}

function InboxRow({ item, onDismiss }: { item: InboxItem; onDismiss?: () => void }) {
  const kind = KIND[item.kind];
  const Icon = kind.icon;
  let action: ReactNode = null;
  if (item.kind === "question") {
    // Plans are answered in conversation, where Perry can pick the thread back up.
    action = <Button size="sm" render={<Link href={`/chat?draft=${encodeURIComponent(`About “${item.title}”: `)}`} />}><MessageSquareIcon />Answer</Button>;
  } else if (item.kind === "job-result" || (item.kind === "job-error" && item.chatId)) {
    action = <Button size="sm" variant="outline" render={<Link href={`/chat/${item.chatId}`} />}><MessageSquareIcon />Open</Button>;
  } else if (item.kind === "watch") {
    action = <Button size="sm" variant="outline" render={<a href={item.url} target="_blank" rel="noopener noreferrer" />}><ExternalLinkIcon />Open page</Button>;
  } else if (item.kind === "task-failed") {
    action = <Button size="sm" variant="outline" render={<Link href="/work?tab=plans" />}>See plan</Button>;
  }
  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start">
      <Icon className={cn("mt-0.5 size-4 shrink-0 max-sm:hidden", kind.tone)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{kind.label} · <RelativeTime at={item.at} /></p>
        <h3 className="mt-0.5 font-medium">{item.title}</h3>
        <p className={cn("mt-1 line-clamp-4 text-sm text-pretty whitespace-pre-line", item.kind === "task-failed" || item.kind === "job-error" ? "text-destructive" : "text-foreground/80")}>
          {item.text}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {action}
        {onDismiss && <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={onDismiss}>Dismiss</Button>}
      </div>
    </li>
  );
}
