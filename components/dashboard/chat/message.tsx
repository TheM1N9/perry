"use client";

import { BrainIcon, CheckIcon, CopyIcon, GitBranchIcon, PencilIcon, PuzzleIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { Work } from "@/convex/dashboard";
import { STARTING } from "@/convex/lib/activity";
import { SKILL_MENTION } from "@/convex/lib/commands";
import { fullDate, timeOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopy } from "../common";
import { AttachmentList, type Attachment } from "./attachments";
import { Markdown } from "./markdown";
import { Spinner, WorkSteps, WorkSummary } from "./work";

export type ChatMessage = { id: string; role: string; text: string; createdAt: number; attachments: Attachment[]; pending?: boolean; memories?: Array<{ id: string; text: string }> };

function Action({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground" aria-label={label} onClick={onClick} disabled={disabled} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Your words, with each skill they name ("$weekly-review") marked as one and
 * linked to it on the Skills page. A $name no skill has stays plain text.
 */
function WithSkills({ text, skills }: { text: string; skills?: ReadonlySet<string> }) {
  if (!skills?.size || !text.includes("$")) return <>{text}</>;
  const parts: ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(SKILL_MENTION)) {
    if (!skills.has(match[1])) continue;
    parts.push(text.slice(from, match.index));
    parts.push(
      <Link key={match.index} href={`/skills?skill=${encodeURIComponent(match[1])}`} data-skill-mention={match[1]} title={`The ${match[1]} skill`}
        className="rounded-md bg-primary/10 px-1.5 py-0.5 font-medium text-primary no-underline [box-decoration-break:clone] hover:bg-primary/15">
        <PuzzleIcon className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />{match[0]}
      </Link>,
    );
    from = match.index + match[0].length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

function CopyAction({ text }: { text: string }) {
  const { copied, copy } = useCopy();
  return <Action label={copied ? "Copied" : "Copy"} onClick={() => copy(text)}>{copied ? <CheckIcon /> : <CopyIcon />}</Action>;
}

/**
 * One turn. Yours sit right in a quiet bubble; the assistant's run the full
 * width of the column, unboxed, since that is what you read. The actions show
 * on hover and focus, and always on the newest reply.
 */
export function MessageRow({ message, work, assistant, latest, canRegenerate, canEdit, canBranch = true, busy, skills, onEdit, onRegenerate, onBranch }: {
  message: ChatMessage;
  /** The run that wrote this reply, when it took steps: "Worked for 46s" above it. */
  work?: Work;
  assistant: string;
  latest: boolean;
  canRegenerate: boolean;
  canEdit: boolean;
  /** Off in a Telegram or WhatsApp chat, which only the web app's own chats branch from. */
  canBranch?: boolean;
  busy: boolean;
  /** The skills there are, so a "$name" of one is marked in your messages. */
  skills?: ReadonlySet<string>;
  onEdit: (text: string) => void;
  onRegenerate: () => void;
  onBranch: () => void;
}) {
  const mine = message.role === "user";
  // Not in the history until its reply saves it, so there is nothing yet to edit or branch from.
  const saved = !message.pending;
  const [editing, setEditing] = useState<string | null>(null);

  if (editing !== null) {
    return (
      <form className="ml-auto w-full max-w-[85%] space-y-2" onSubmit={(event) => { event.preventDefault(); if (editing.trim()) { onEdit(editing); setEditing(null); } }}>
        <Textarea autoFocus aria-label="Edit your message" value={editing} className="max-h-72 min-h-20 rounded-2xl bg-muted px-4 py-3 text-[15px]"
          onChange={(event) => setEditing(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setEditing(null);
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
          }} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
          <Button type="submit" disabled={!editing.trim() || busy}>Save and resend</Button>
        </div>
      </form>
    );
  }

  return (
    <div className={cn("group/message flex flex-col", mine ? "items-end" : "items-start")} data-role={mine ? "user" : "assistant"}>
      <h3 className="sr-only">{mine ? "You said" : `${assistant} said`}</h3>
      {mine ? (
        <div className="max-w-[85%] rounded-3xl bg-muted px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
          <WithSkills text={message.text} skills={skills} />
          <AttachmentList attachments={message.attachments} align="end" />
        </div>
      ) : (
        <div className="w-full min-w-0">
          {work && <WorkSummary work={work} />}
          <Markdown text={message.text} />
          <AttachmentList attachments={message.attachments} />
          {message.memories && message.memories.length > 0 && <FromMemory memories={message.memories} />}
        </div>
      )}
      <div className={cn(
        "mt-1 flex items-center gap-0.5 transition-opacity [@media(hover:hover)]:opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100",
        !mine && "-ml-2", latest && !mine && "[@media(hover:hover)]:opacity-100",
      )}>
        {mine && (
          <time className="nums mr-1 text-xs text-muted-foreground" dateTime={new Date(message.createdAt).toISOString()} title={fullDate(message.createdAt)}>
            {timeOf(message.createdAt)}
          </time>
        )}
        <CopyAction text={message.text} />
        {mine && canEdit && saved && <Action label="Edit and resend" disabled={busy} onClick={() => setEditing(message.text)}><PencilIcon /></Action>}
        {!mine && canRegenerate && saved && <Action label="Write this reply again" disabled={busy} onClick={onRegenerate}><RefreshCwIcon /></Action>}
        {saved && canBranch && <Action label="Branch into a new chat" disabled={busy} onClick={onBranch}><GitBranchIcon /></Action>}
        {!mine && (
          <time className="nums ml-1 text-xs text-muted-foreground" dateTime={new Date(message.createdAt).toISOString()} title={fullDate(message.createdAt)}>
            {timeOf(message.createdAt)}
          </time>
        )}
      </div>
    </div>
  );
}

/**
 * What a reply remembered: the memories it said it relied on, each a link to
 * it on the Memory page, where a wrong one can be put right.
 */
function FromMemory({ memories }: { memories: Array<{ id: string; text: string }> }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" data-memories>
      <BrainIcon className="size-3.5" aria-hidden />
      <span>From memory:</span>
      {memories.map((memory) => (
        <Link key={memory.id} href={`/memory?q=${encodeURIComponent(memory.text.slice(0, 60))}`} title={memory.text}
          className="max-w-64 truncate rounded-full border px-2 py-0.5 hover:bg-muted hover:text-foreground">
          {memory.text}
        </Link>
      ))}
    </div>
  );
}

/** A message you sent, before the server lists it; "Sending…" until the server has taken it. */
export function PendingRow({ text, attachments, sent, skills }: { text: string; attachments: Attachment[]; sent: boolean; skills?: ReadonlySet<string> }) {
  return (
    <div className="flex flex-col items-end" data-role="user" data-pending>
      <div className={cn("max-w-[85%] rounded-3xl bg-muted px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]", !sent && "opacity-70")}>
        <WithSkills text={text} skills={skills} />
        <AttachmentList attachments={attachments} align="end" />
      </div>
      {!sent && <span className="mt-1 text-xs text-muted-foreground" role="status">Sending…</span>}
    </div>
  );
}

/**
 * The reply being written: each step the run has taken so far, in order
 * (dashboard.getChatWork), so none goes by unseen; then what has streamed of
 * the words, or "Thinking" while nothing else is going on.
 */
export function ReplyInProgress({ streaming, work, now }: { streaming?: string; work?: Work; now: number }) {
  const steps = work?.steps ?? [];
  const busy = steps.some((step) => step.status === "running");
  return (
    <div className="min-w-0 space-y-2" data-role="assistant" {...(streaming ? { "data-streaming": true } : { "data-thinking": true })}>
      {steps.length > 0 && <WorkSteps steps={steps} live now={now} />}
      {streaming ? (
        <div>
          <Markdown text={streaming} />
          {!busy && <span className="mt-1 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-foreground/60 align-middle motion-reduce:animate-none" aria-hidden />}
        </div>
      ) : !busy && (
        <p className="flex items-center gap-2 text-[15px] font-medium" data-step={STARTING.label}>
          <Spinner />
          <span className="shimmer">{STARTING.label}</span>
        </p>
      )}
    </div>
  );
}
