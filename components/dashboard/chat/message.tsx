"use client";

import { CheckIcon, CopyIcon, GitBranchIcon, PencilIcon, RefreshCwIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { fullDate, timeOf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopy } from "../common";
import { AttachmentList, type Attachment } from "./attachments";
import { Markdown } from "./markdown";

export type ChatMessage = { id: string; role: string; text: string; createdAt: number; attachments: Attachment[]; pending?: boolean };

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
export function MessageRow({ message, assistant, latest, canRegenerate, canEdit, busy, onEdit, onRegenerate, onBranch }: {
  message: ChatMessage;
  assistant: string;
  latest: boolean;
  canRegenerate: boolean;
  canEdit: boolean;
  busy: boolean;
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
          {message.text}
          <AttachmentList attachments={message.attachments} align="end" />
        </div>
      ) : (
        <div className="w-full min-w-0">
          <Markdown text={message.text} />
          <AttachmentList attachments={message.attachments} />
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
        {saved && <Action label="Branch into a new chat" disabled={busy} onClick={onBranch}><GitBranchIcon /></Action>}
        {!mine && (
          <time className="nums ml-1 text-xs text-muted-foreground" dateTime={new Date(message.createdAt).toISOString()} title={fullDate(message.createdAt)}>
            {timeOf(message.createdAt)}
          </time>
        )}
      </div>
    </div>
  );
}

/** A message you sent, before the server lists it; "Sending…" until the server has taken it. */
export function PendingRow({ text, attachments, sent }: { text: string; attachments: Attachment[]; sent: boolean }) {
  return (
    <div className="flex flex-col items-end" data-role="user" data-pending>
      <div className={cn("max-w-[85%] rounded-3xl bg-muted px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]", !sent && "opacity-70")}>
        {text}
        <AttachmentList attachments={attachments} align="end" />
      </div>
      {!sent && <span className="mt-1 text-xs text-muted-foreground" role="status">Sending…</span>}
    </div>
  );
}

/** The reply being written: what has streamed so far, or a shimmer while it thinks. */
export function ReplyInProgress({ streaming }: { streaming?: string }) {
  if (streaming) {
    return (
      <div className="min-w-0" data-role="assistant" data-streaming>
        <Markdown text={streaming} />
        <span className="mt-1 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-foreground/60 align-middle motion-reduce:animate-none" aria-hidden />
      </div>
    );
  }
  return <p className="shimmer text-[15px] font-medium" data-role="assistant" data-thinking>Thinking</p>;
}
