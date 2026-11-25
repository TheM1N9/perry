"use client";

import { useMutation, useQuery } from "@/client/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { InboxItem } from "@/convex/dashboard";
import { ago, errorText } from "@/lib/format";
import { useDashboardKey } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { ApprovalCard } from "@/components/dashboard/approval-card";
import { List } from "@/components/dashboard/common";
import { Empty } from "./empty";
import { boardLink, NEEDS_YOU } from "@/lib/board-links";

const LABEL: Record<InboxItem["kind"], string> = {
  delivery: "Notification delivery",
  question: "A task needs your answer",
  "task-failed": "A task failed",
  "job-error": "A schedule failed",
  "job-result": "New from a schedule",
  watch: "A watch fired",
};

/** Decisions waiting on the owner, followed by unread updates that need no answer. */
export function PetNeedsYou({ now, onChat, open }: {
  now: number;
  /** Open a chat in the pet, with something already typed. */
  onChat: (id: Id<"conversations"> | null, draft?: string) => void;
  open: (path: string) => void;
}) {
  const key = useDashboardKey();
  const approvals = useQuery(api.approvals.pending, { key });
  const approvalCount = useQuery(api.approvals.pendingCount, { key });
  const nativeQuestions = useQuery(api.questions.pendingCount, { key });
  const inbox = useQuery(api.dashboard.getInbox, { key });
  const dismiss = useMutation(api.dashboard.dismissInbox);
  const live = (approvals ?? []).filter((item) => item.expiresAt > now);
  const questions = (inbox ?? []).filter(item => item.kind === "question");
  const updates = (inbox ?? []).filter(item => item.kind !== "question");

  if (approvals === undefined || approvalCount === undefined || nativeQuestions === undefined || inbox === undefined) {
    return <div className="space-y-2.5 px-2.5" role="status" aria-label="Loading"><Skeleton className="h-28 rounded-xl" /><Skeleton className="h-20 rounded-xl" /></div>;
  }
  if (!approvalCount && !nativeQuestions && !inbox.length) return <Empty title="You’re all caught up" />;
  return (
    <ScrollArea className="min-h-0 flex-1">
    <div className="space-y-4 px-2.5 pb-2.5 [&_article_header]:px-1.5 [&_article>div]:px-1.5 [&_article_footer]:px-1.5 [&_article]:text-sm">
      {live.map((approval) => <ApprovalCard key={approval.id} approval={approval} now={now} showChat={false} bare />)}
      {approvalCount > live.length && <Button variant="outline" size="sm" className="w-full" onClick={() => open(boardLink({ tab: NEEDS_YOU }))}>Review all {approvalCount} approvals</Button>}
      {questions.length > 0 && <section aria-label="Task questions">
        <h3 className="px-1.5 text-xs font-medium text-muted-foreground">Questions</h3>
        <List label="Task questions" className="*:px-1.5">
          {questions.map(item => <li key={item.id} className="py-2.5">
            <p className="text-2xs text-muted-foreground">{LABEL.question} · {ago(item.at, now)}</p>
            <p className="mt-0.5 text-sm font-medium">{item.title}</p>
            <p className="mt-0.5 line-clamp-3 text-xs text-pretty whitespace-pre-line">{item.text}</p>
            <Button variant="outline" size="sm" className="mt-1.5 px-3" onClick={() => open(boardLink({ channel: "tasks", thread: `task:${item.id}`, tab: NEEDS_YOU }))}>Answer</Button>
          </li>)}
        </List>
      </section>}
      {nativeQuestions > 0 && <div className="space-y-1.5 px-1.5">
        <p className="text-sm">{nativeQuestions === 1 ? "A chat is waiting for your answer." : `${nativeQuestions} questions are waiting in chats.`}</p>
        <Button variant="outline" size="sm" onClick={() => open(boardLink({ tab: NEEDS_YOU }))}>View chat questions</Button>
      </div>}
      {updates.length > 0 && <section aria-label="Updates" className="space-y-1.5">
        <div className="flex items-center justify-between gap-2 px-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">Updates</h3>
          <Button variant="ghost" size="sm" onClick={() => open(boardLink({ tab: "updates" }))}>Open Updates</Button>
        </div>
        <List label="Updates" className="*:px-1.5">
          {updates.map((item) => {
            const act = item.kind === "delivery" ? { label: item.chatId ? "Open chat" : "Notification settings", run: () => item.chatId ? onChat(item.chatId) : open("/settings/notifications") }
              : item.kind === "job-result" || (item.kind === "job-error" && item.chatId) ? { label: "Open", run: () => onChat(item.chatId!) }
                : item.kind === "watch" ? { label: "Open page", run: () => window.open(item.url, "_blank") }
                  : item.kind === "job-error" ? { label: "See schedule", run: () => open(boardLink({ thread: `job:${item.id}`, tab: "all" })) }
                    : { label: "See task", run: () => open(boardLink({ channel: "tasks", thread: `task:${item.id}`, tab: "all" })) };
            return (
              <li key={`${item.kind}-${item.id}`} className="px-3 py-2.5">
                <p className="text-2xs text-muted-foreground">{LABEL[item.kind]} · {ago(item.at, now)}</p>
                <p className="mt-0.5 text-sm font-medium">{item.title}</p>
                <p className={cn("mt-0.5 line-clamp-3 text-xs text-pretty whitespace-pre-line", item.kind === "task-failed" || item.kind === "job-error" ? "text-destructive" : "text-foreground/80")}>{item.text}</p>
                <div className="mt-1.5 flex gap-1">
                  <Button variant="outline" size="sm" className="px-3" onClick={act.run}>{act.label}</Button>
                  <Button variant="ghost" size="sm" className="px-3 font-normal text-muted-foreground" onClick={() => void dismiss({ key, items: [{ kind: item.kind, id: item.id, at: item.at }] }).catch(cause => toast.error(errorText(cause)))}>Mark read</Button>
                </div>
              </li>
            );
          })}
        </List>
      </section>}
    </div>
    </ScrollArea>
  );
}
