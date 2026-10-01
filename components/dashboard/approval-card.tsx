"use client";

import Link from "next/link";
import { FolderIcon, GlobeIcon, MessageCircleIcon, ShieldAlertIcon, TerminalIcon, FilePenIcon, UserPlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useMutation } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { PendingApproval } from "@/convex/approvals";
import { errorText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TextTip } from "./common";

const KIND = { command: "run a command", file: "change files", write: "write a file", browser: "do this in its browser", contact: "talk with someone new", message: "message someone" } as const;
const ICON = { command: TerminalIcon, file: FilePenIcon, write: FilePenIcon, browser: GlobeIcon, contact: UserPlusIcon, message: MessageCircleIcon } as const;

function remaining(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * What a computer is waiting to be allowed to do, exactly as it will run. The
 * runner asks in its terminal and on Telegram too; whichever answer comes
 * first wins, so a late one is told it was too late.
 */
export function ApprovalCard({ approval, now, showChat = true }: { approval: PendingApproval; now: number; showChat?: boolean }) {
  const { dashboardKey } = useSession();
  const decide = useMutation(api.approvals.decide).withOptimisticUpdate((store, args) => {
    const list = store.getQuery(api.approvals.pending, { key: args.key });
    if (list) store.setQuery(api.approvals.pending, { key: args.key }, list.filter((item) => item.id !== args.id));
  });
  const [answering, setAnswering] = useState<"approve" | "decline" | "always" | null>(null);
  const Icon = ICON[approval.kind];
  const left = approval.expiresAt - now;

  const answer = async (choice: "approve" | "decline" | "always") => {
    setAnswering(choice);
    try {
      const applied = await decide({ key: dashboardKey, id: approval.id, approved: choice !== "decline", always: choice === "always" });
      if (!applied) toast.error("That request was already answered, or it expired.");
      else toast.success(choice === "always" ? "Allowed, and saved as a rule for next time." : choice === "approve" ? "Approved. It's going ahead." : "Declined. It won't run.");
    } catch (cause) {
      toast.error(`Couldn't send your answer: ${errorText(cause)}`);
    } finally {
      setAnswering(null);
    }
  };

  return (
    <article aria-label={`${approval.runner} wants to ${KIND[approval.kind]}`}
      className="overflow-hidden rounded-2xl border border-warning/35 bg-card shadow-raised">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 bg-warning-soft px-4 py-2.5 text-sm">
        <ShieldAlertIcon className="size-4 shrink-0 text-warning" aria-hidden />
        <span className="font-medium text-foreground">{approval.runner} wants to {KIND[approval.kind]}</span>
        {showChat && approval.chat && (
          <Link href={`/chat/${approval.chat.id}`} className="min-w-0 truncate text-muted-foreground underline-offset-2 hover:underline">
            in {approval.chat.title}
          </Link>
        )}
        <TextTip tip="Unanswered requests are declined when this runs out" spoken="then it is declined"
          className={cn("nums ml-auto text-xs", left < 60_000 ? "font-medium text-warning" : "text-muted-foreground")}>
          {remaining(left)} left
        </TextTip>
      </header>
      <div className="space-y-3 px-4 py-3.5">
        <pre className="flex gap-2.5 overflow-x-auto rounded-lg bg-muted px-3 py-2.5 font-mono text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
          <Icon className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <code>{approval.title}</code>
        </pre>
        {(approval.cwd || approval.detail) && (
          <dl className="grid gap-1 text-sm">
            {approval.cwd && (
              <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
                <dt className="sr-only">Folder</dt>
                <FolderIcon className="size-3.5 shrink-0" aria-hidden />
                <dd className="min-w-0"><TextTip tip={approval.cwd} className="block truncate font-mono text-xs">{approval.cwd}</TextTip></dd>
              </div>
            )}
            {approval.detail && <div><dt className="sr-only">Detail</dt><dd className="text-pretty text-muted-foreground">{approval.detail}</dd></div>}
          </dl>
        )}
        {approval.review && (
          <p className="text-sm text-pretty">
            <span className="font-medium">Reviewer: {approval.review.verdict}.</span>{" "}
            <span className="text-muted-foreground">{approval.review.reason}</span>
          </p>
        )}
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
        {approval.alwaysAllow && <p className="mr-auto min-w-0 text-xs text-pretty text-muted-foreground">Always allow saves a rule for {approval.alwaysAllow}.</p>}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" disabled={answering !== null} onClick={() => void answer("decline")}>
            {answering === "decline" && <Spinner />}Decline
          </Button>
          {approval.alwaysAllow && (
            <Button variant="outline" disabled={answering !== null} onClick={() => void answer("always")}>
              {answering === "always" && <Spinner />}Always allow
            </Button>
          )}
          <Button disabled={answering !== null} onClick={() => void answer("approve")}>
            {answering === "approve" && <Spinner />}Approve
          </Button>
        </div>
      </footer>
    </article>
  );
}
