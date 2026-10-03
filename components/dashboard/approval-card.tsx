"use client";

import Link from "next/link";
import { BrainIcon, FolderIcon, GlobeIcon, MessageCircleIcon, ShieldAlertIcon, TerminalIcon, FilePenIcon, UserPlusIcon } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { TextTip } from "./common";

const KIND = { command: "run a command", file: "change files", write: "write a file", browser: "do this in its browser", contact: "talk with someone new", message: "message someone", brain: "change Brain" } as const;
const ICON = { command: TerminalIcon, file: FilePenIcon, write: FilePenIcon, browser: GlobeIcon, contact: UserPlusIcon, message: MessageCircleIcon, brain: BrainIcon } as const;

function remaining(ms: number) {
  if (ms > 2 * 86_400_000) return `${Math.floor(ms / 86_400_000)} days`;
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * What a computer is waiting to be allowed to do, exactly as it will run. The
 * runner asks in its terminal and on Telegram too; whichever answer comes
 * first wins, so a late one is told it was too late. `bare` drops the card
 * around it, for a place that is already a box of its own, like the pet's
 * panel.
 */
export function ApprovalCard({ approval, now, showChat = true, bare }: { approval: PendingApproval; now: number; showChat?: boolean; bare?: boolean }) {
  const { dashboardKey } = useSession();
  const decide = useMutation(api.approvals.decide).withOptimisticUpdate((store, args) => {
    const list = store.getQuery(api.approvals.pending, { key: args.key });
    if (list) store.setQuery(api.approvals.pending, { key: args.key }, list.filter((item) => item.id !== args.id));
  });
  const [answering, setAnswering] = useState<"approve" | "decline" | "always" | null>(null);
  // A change to Brain can be approved in the owner's own words: what the lines become, one per line.
  const [editing, setEditing] = useState<string | null>(null);
  const proposal = approval.proposal;
  // Lines that move to another page keep their words: the card says where they go, and there is nothing to edit.
  const moves = proposal?.kind === "move" || proposal?.kind === "split" || proposal?.kind === "mergePages";
  const Icon = ICON[approval.kind];
  const left = approval.expiresAt - now;

  const answer = async (choice: "approve" | "decline" | "always") => {
    setAnswering(choice);
    try {
      const edited = proposal && editing !== null && choice === "approve" ? editing.split("\n").map((line) => line.trim()).filter(Boolean) : undefined;
      const applied = await decide({ key: dashboardKey, id: approval.id, approved: choice !== "decline", always: choice === "always", ...(edited ? { edited } : {}) });
      if (!applied) toast.error("That request was already answered, or it expired.");
      else if (proposal) toast.success(choice === "approve" ? "Approved. Brain is changed; you can undo it in Brain." : "Declined. Brain stays as it is.");
      else toast.success(choice === "always" ? "Allowed, and saved as a rule for next time." : choice === "approve" ? "Approved. It's going ahead." : "Declined. It won't run.");
    } catch (cause) {
      toast.error(`Couldn't send your answer: ${errorText(cause)}`);
    } finally {
      setAnswering(null);
    }
  };

  return (
    <article aria-label={`${approval.runner} wants to ${KIND[approval.kind]}`} data-bare={bare || undefined}
      className={cn(!bare && "overflow-hidden rounded-2xl border border-warning/35 bg-card shadow-raised")}>
      <header className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 px-4 text-sm", bare ? "pt-1" : "bg-warning-soft py-2.5")}>
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
      {proposal ? (
        <div className={cn("space-y-3 px-4 text-sm", bare ? "py-2.5" : "py-3.5")} data-proposal={proposal.kind}>
          <p className="font-medium text-pretty">
            {approval.title}
            {proposal.page && <> · <Link href={`/brain/${proposal.page.id}`} className="font-normal text-muted-foreground underline-offset-2 hover:underline">{proposal.page.title}</Link></>}
          </p>
          {approval.detail && <p className="text-pretty text-muted-foreground">{approval.detail.split("\n\n")[0]}</p>}
          {proposal.before.length > 0 && (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground">{proposal.kind === "rollup" || proposal.kind === "infer" || proposal.kind === "topic" ? "From" : moves ? "Lines" : "Now"}</h3>
              <ul className="mt-1 space-y-0.5" data-before>
                {proposal.before.map((line, index) => <li key={index} className={cn("text-pretty", proposal.kind === "merge" || proposal.kind === "condense" ? "text-muted-foreground line-through decoration-muted-foreground/50" : "text-muted-foreground")}>{line}</li>)}
              </ul>
            </div>
          )}
          {moves ? (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground">Goes to</h3>
              <p className="mt-1" data-target>
                {proposal.target
                  ? <Link href={`/brain/${proposal.target.id}`} className="underline-offset-2 hover:underline">{proposal.target.title}</Link>
                  : <>A new page, {proposal.title}</>}
                {proposal.targetSection && <span className="text-muted-foreground"> › {proposal.targetSection}</span>}
              </p>
            </div>
          ) : (
          <div>
            <h3 className="text-xs font-medium text-muted-foreground">{proposal.kind === "rollup" ? "Summary" : proposal.kind === "infer" || proposal.kind === "outside" ? "Adds" : proposal.kind === "topic" ? `A new page, ${proposal.title ?? ""}` : "After"}</h3>
            {editing === null ? (
              <ul className="mt-1 space-y-0.5" data-after>{proposal.after.map((line, index) => <li key={index} className="text-pretty">{line}</li>)}</ul>
            ) : (
              <Textarea aria-label="What the lines become, one per line" className="mt-1 min-h-24" value={editing} onChange={(event) => setEditing(event.target.value)} />
            )}
          </div>
          )}
        </div>
      ) : (
      <div className={cn("space-y-3 px-4", bare ? "py-2.5" : "py-3.5")}>
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
      )}
      <footer className={cn("flex flex-wrap items-center gap-2 px-4", bare ? "pb-1" : "border-t py-3")}>
        {approval.alwaysAllow && <p className="mr-auto min-w-0 text-xs text-pretty text-muted-foreground">Always allow saves a rule for {approval.alwaysAllow}.</p>}
        <div className="ml-auto flex flex-wrap gap-2">
          {proposal && !moves && editing === null && (
            <Button variant="ghost" disabled={answering !== null} onClick={() => setEditing(proposal.after.join("\n"))}>Edit</Button>
          )}
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
