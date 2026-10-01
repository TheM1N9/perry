"use client";

import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { InboxItem } from "@/convex/dashboard";
import { ago } from "@/lib/format";
import { useDashboardKey } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ApprovalCard } from "@/components/dashboard/approval-card";
import { List } from "@/components/dashboard/common";
import { Empty } from "./empty";

const LABEL: Record<InboxItem["kind"], string> = {
  question: "A plan needs your answer",
  "task-failed": "A plan failed",
  "job-error": "A schedule failed",
  "job-result": "New from a schedule",
  watch: "A watch fired",
};

/** What is waiting on you, as the dashboard's Needs you has it: approvals first, answered here. */
export function PetNeedsYou({ now, onChat, open }: {
  now: number;
  /** Open a chat in the pet, with something already typed. */
  onChat: (id: Id<"conversations"> | null, draft?: string) => void;
  open: (path: string) => void;
}) {
  const key = useDashboardKey();
  const approvals = useQuery(api.approvals.pending, { key });
  const inbox = useQuery(api.dashboard.getInbox, { key });
  const dismiss = useMutation(api.dashboard.dismissInbox);
  const live = (approvals ?? []).filter((item) => item.expiresAt > now);

  if (approvals === undefined || inbox === undefined) {
    return <div className="space-y-2.5 px-2.5" role="status" aria-label="Loading"><Skeleton className="h-28 rounded-xl" /><Skeleton className="h-20 rounded-xl" /></div>;
  }
  if (!live.length && !inbox.length) return <Empty title="You’re all caught up">When Perry needs a yes from you, or a plan or schedule has news, it shows up here.</Empty>;
  return (
    <ScrollArea className="min-h-0 flex-1">
    <div className="space-y-4 px-2.5 pb-2.5 [&_article_header]:px-1.5 [&_article>div]:px-1.5 [&_article_footer]:px-1.5 [&_article]:text-sm">
      {live.map((approval) => <ApprovalCard key={approval.id} approval={approval} now={now} showChat={false} bare />)}
      {inbox.length > 0 && (
        <List label="Updates" className={cn("*:px-1.5", live.length > 0 && "border-t")}>
          {inbox.map((item) => {
            const act = item.kind === "question" ? { label: "Answer", run: () => onChat(null, `About “${item.title}”: `) }
              : item.kind === "job-result" || (item.kind === "job-error" && item.chatId) ? { label: "Open", run: () => onChat(item.chatId!) }
                : item.kind === "watch" ? { label: "Open page", run: () => window.open(item.url, "_blank") }
                  : { label: "See plan", run: () => open("/work?tab=plans") };
            return (
              <li key={`${item.kind}-${item.id}`} className="px-3 py-2.5">
                <p className="text-2xs text-muted-foreground">{LABEL[item.kind]} · {ago(item.at, now)}</p>
                <p className="mt-0.5 text-sm font-medium">{item.title}</p>
                <p className={cn("mt-0.5 line-clamp-3 text-xs text-pretty whitespace-pre-line", item.kind === "task-failed" || item.kind === "job-error" ? "text-destructive" : "text-foreground/80")}>{item.text}</p>
                <div className="mt-1.5 flex gap-1">
                  <Button variant="outline" size="sm" className="px-3" onClick={act.run}>{act.label}</Button>
                  {item.kind !== "question" && (
                    <Button variant="ghost" size="sm" className="px-3 font-normal text-muted-foreground" onClick={() => void dismiss({ key, items: [{ kind: item.kind, id: item.id }] }).catch(() => {})}>Dismiss</Button>
                  )}
                </div>
              </li>
            );
          })}
        </List>
      )}
    </div>
    </ScrollArea>
  );
}
