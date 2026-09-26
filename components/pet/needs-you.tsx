"use client";

import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { InboxItem } from "@/convex/dashboard";
import { ago } from "@/lib/format";
import { useDashboardKey } from "@/lib/session";
import { cn } from "@/lib/utils";
import { ApprovalCard } from "@/components/dashboard/approval-card";
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

  if (approvals === undefined || inbox === undefined) return <p className="px-3.5 py-3 text-[13px] text-muted-foreground">Loading…</p>;
  if (!live.length && !inbox.length) return <Empty title="You’re all caught up">When Perry needs a yes from you, or a plan or schedule has news, it shows up here.</Empty>;
  return (
    <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-2.5 pb-2.5 [&_article_header]:px-3 [&_article>div]:px-3 [&_article_footer]:px-3 [&_article]:text-[13px]">
      {live.map((approval) => <ApprovalCard key={approval.id} approval={approval} now={now} showChat={false} />)}
      {inbox.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card" aria-label="Updates">
          {inbox.map((item) => {
            const act = item.kind === "question" ? { label: "Answer", run: () => onChat(null, `About “${item.title}”: `) }
              : item.kind === "job-result" || (item.kind === "job-error" && item.chatId) ? { label: "Open", run: () => onChat(item.chatId!) }
                : item.kind === "watch" ? { label: "Open page", run: () => window.open(item.url, "_blank") }
                  : { label: "See plan", run: () => open("/work?tab=plans") };
            return (
              <li key={`${item.kind}-${item.id}`} className="px-3 py-2.5">
                <p className="text-[11.5px] text-muted-foreground">{LABEL[item.kind]} · {ago(item.at, now)}</p>
                <p className="mt-0.5 text-[13.5px] font-medium">{item.title}</p>
                <p className={cn("mt-0.5 line-clamp-3 text-[12.5px] text-pretty whitespace-pre-line", item.kind === "task-failed" || item.kind === "job-error" ? "text-destructive" : "text-foreground/80")}>{item.text}</p>
                <div className="mt-1.5 flex gap-1">
                  <button type="button" onClick={act.run} className="h-7 cursor-pointer rounded-lg border bg-background px-3 text-[12.5px] font-medium hover:bg-muted">{act.label}</button>
                  {item.kind !== "question" && (
                    <button type="button" onClick={() => void dismiss({ key, items: [{ kind: item.kind, id: item.id }] }).catch(() => {})}
                      className="h-7 cursor-pointer rounded-lg px-3 text-[12.5px] text-muted-foreground hover:bg-muted">Dismiss</button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
