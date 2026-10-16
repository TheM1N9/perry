"use client";

import { BrainIcon, CheckIcon, CopyIcon, FilePlusIcon, GitBranchIcon, PencilIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { Fragment, memo, type ReactNode } from "react";
import type { Work } from "@/convex/dashboard";
import { STARTING } from "@/convex/lib/activity";
import { fullDate, timeOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { Message, MessageContent, MessageFooter } from "@/components/ui/message";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopy } from "../common";
import { AttachmentList, type Attachment } from "./attachments";
import { Markdown } from "./markdown";
import { QueueRemoveButton, type QueuedMessage } from "./queue-remove-button";
import { Spinner, WorkSummary, type WorkState } from "./work";

export type ChatMessage = { attachmentKey?: string; id: string; role: string; text: string; createdAt: number; attachments: Attachment[]; pending?: boolean; queued?: QueuedMessage; memories?: Array<{ id: string; text: string }> };

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

function CopyAction({ text }: { text: string }) {
  const { copied, copy } = useCopy();
  return <Action label={copied ? "Copied" : "Copy"} onClick={() => copy(text)}>{copied ? <CheckIcon /> : <CopyIcon />}</Action>;
}

/**
 * One turn. Yours sit right in a quiet bubble; the assistant's run the full
 * width of the column, unboxed, since that is what you read. The actions show
 * on hover and focus, and always on the newest reply.
 */
export const MessageRow = memo(function MessageRow({ message, work, assistant, latest, canRegenerate, canEdit, canBranch = true, busy, skills, onEdit, onRegenerate, onBranch, onSaveNote }: {
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
  onEdit: (message: ChatMessage) => void;
  onRegenerate: (message: ChatMessage) => void;
  onBranch: (message: ChatMessage) => void;
  /** Keep this reply as a note of its own. */
  onSaveNote?: (message: ChatMessage) => void;
}) {
  const mine = message.role === "user";
  // Not in the history until its reply saves it, so there is nothing yet to edit or branch from.
  const saved = !message.pending;
  return (
    <Message id={message.attachmentKey ? `message-${message.attachmentKey}` : undefined} align={mine ? "end" : "start"} data-role={mine ? "user" : "assistant"}>
      <MessageContent className="gap-1">
        <h3 className="sr-only">{mine ? "You said" : `${assistant} said`}</h3>
        {mine ? (
          <Bubble align="end" variant="muted" className="max-w-[85%]">
            <BubbleContent className="rounded-3xl px-4 py-2.5 text-md [overflow-wrap:anywhere]">
              <Markdown text={message.text} skills={skills} />
              <AttachmentList attachments={message.attachments} align="end" />
            </BubbleContent>
          </Bubble>
        ) : (
          <div className="w-full min-w-0">
            {work && <WorkSummary work={work} state={work.status === "ok" ? "done" : "failed"} />}
            <Markdown text={message.text} />
            <AttachmentList attachments={message.attachments} />
            {message.memories && message.memories.length > 0 && <FromMemory memories={message.memories} />}
          </div>
        )}
        {mine && message.queued && <QueueRemoveButton queued={message.queued} />}
        <MessageFooter className={cn(
          "gap-0.5 px-0 font-normal transition-opacity [@media(hover:hover)]:opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100",
          !mine && "-ml-2", latest && !mine && "[@media(hover:hover)]:opacity-100",
        )}>
          {mine && (
            <time className="nums mr-1 text-xs text-muted-foreground" dateTime={new Date(message.createdAt).toISOString()} title={fullDate(message.createdAt)}>
              {timeOf(message.createdAt)}
            </time>
          )}
          <CopyAction text={message.text} />
          {mine && canEdit && saved && <Action label="Edit and resend" disabled={busy} onClick={() => onEdit(message)}><PencilIcon /></Action>}
          {!mine && canRegenerate && saved && <Action label="Write this reply again" disabled={busy} onClick={() => onRegenerate(message)}><RefreshCwIcon /></Action>}
          {saved && canBranch && <Action label="Branch into a new chat" disabled={busy} onClick={() => onBranch(message)}><GitBranchIcon /></Action>}
          {!mine && saved && onSaveNote && <Action label="Save as note" onClick={() => onSaveNote?.(message)}><FilePlusIcon /></Action>}
          {!mine && (
            <time className="nums ml-1 text-xs text-muted-foreground" dateTime={new Date(message.createdAt).toISOString()} title={fullDate(message.createdAt)}>
              {timeOf(message.createdAt)}
            </time>
          )}
        </MessageFooter>
      </MessageContent>
    </Message>
  );
});

/**
 * What a reply remembered: the memories it said it relied on, each a link to
 * it in Brain, where a wrong one can be put right.
 */
function FromMemory({ memories }: { memories: Array<{ id: string; text: string }> }) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" data-memories>
      <BrainIcon className="size-3.5" aria-hidden />
      <span>From memory:</span>
      {memories.map((memory, index) => (
        <Fragment key={memory.id}>
        {index > 0 && <span aria-hidden>·</span>}
        <Tooltip>
          <TooltipTrigger render={<Link href={`/brain?q=${encodeURIComponent(memory.text.slice(0, 60))}`} />}
            className="max-w-64 truncate rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50">
            {memory.text}
          </TooltipTrigger>
          <TooltipContent className="max-w-80 text-pretty">{memory.text}</TooltipContent>
        </Tooltip>
        </Fragment>
      ))}
    </div>
  );
}

/** A message you sent, before the server lists it; "Sending…" until the server has taken it. */
export function PendingRow({ text, attachments, sent, skills }: { text: string; attachments: Attachment[]; sent: boolean; skills?: ReadonlySet<string> }) {
  return (
    <Message align="end" data-role="user" data-pending>
      <MessageContent className="gap-1">
        <Bubble align="end" variant="muted" className={cn("max-w-[85%]", !sent && "opacity-70")}>
          <BubbleContent className="rounded-3xl px-4 py-2.5 text-md [overflow-wrap:anywhere]">
            <Markdown text={text} skills={skills} />
            <AttachmentList attachments={attachments} align="end" />
          </BubbleContent>
        </Bubble>
        {!sent && <MessageFooter className="px-0 font-normal" role="status">Sending…</MessageFooter>}
      </MessageContent>
    </Message>
  );
}

/**
 * The reply being written: each step the run has taken so far, in order
 * (dashboard.getChatWork), so none goes by unseen; then what has streamed of
 * the words, or "Thinking" while nothing else is going on.
 */
export function ReplyInProgress({ streaming, work, now, approving = false, unresponsive = false }: { streaming?: string; work?: Work; now: number; approving?: boolean; unresponsive?: boolean }) {
  const steps = work?.steps ?? [];
  // Over (its reply on its way to the page), on a step, or held for the owner's approval: either way, not thinking.
  const over = work?.finishedAt !== undefined;
  const busy = unresponsive || over || approving || steps.some((step) => step.status === "running");
  const state: WorkState = unresponsive ? "unresponsive" : over ? (work?.status === "ok" ? "done" : "failed") : approving ? "waiting" : "working";
  return (
    <div className="min-w-0 space-y-2" data-role="assistant" {...(unresponsive ? { "data-unresponsive": true } : streaming ? { "data-streaming": true } : { "data-thinking": true })}>
      {work && <WorkSummary work={work} state={state} now={now} />}
      {unresponsive && <p role="status" data-turn-health="unresponsive" className="text-sm text-muted-foreground">Your computer is unresponsive. Waiting for it to reconnect…</p>}
      {streaming ? (
        <div>
          <Markdown text={streaming} streaming />
          {!busy && <span className="mt-1 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-foreground/60 align-middle motion-reduce:animate-none" aria-hidden />}
        </div>
      ) : !busy && (
        <p className="flex items-center gap-2 text-md font-medium" data-step={STARTING.label}>
          <Spinner />
          <span className="shimmer motion-reduce:shimmer-none">{STARTING.label}</span>
        </p>
      )}
    </div>
  );
}
