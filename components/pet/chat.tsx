"use client";

import { ArrowUpIcon, ChevronDownIcon, ExternalLinkIcon, PlusIcon, SquareIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorText } from "@/lib/format";
import { useDashboardKey } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/dashboard/chat/markdown";
import { describe } from "@/convex/lib/shortcuts";
import { Empty } from "./empty";
import { Listening, MicButton, type Voice } from "./voice";

/**
 * The pet's chat: one of your chats with Perry, the same one the dashboard
 * shows, with the same memory and everything Perry knows. Pick another from
 * the list, start a new one, or open it in the dashboard for the rest (files,
 * models, branching).
 */

export type PetChatId = Id<"conversations"> | null;

export function PetChat({ chatId, onChatId, draft, onDraft, open, voice, hotkey, byHotkey, sendSignal, onTalk, onTalkSend, onTalkCancel }: {
  chatId: PetChatId;
  onChatId: (id: PetChatId) => void;
  draft: string;
  onDraft: (text: string) => void;
  open: (path: string) => void;
  /** Talking to him, where his window can hear (not in a plain browser). */
  voice?: Voice;
  hotkey?: string | null;
  /** Whether he is listening because of the hotkey, which is let go of to send, or the mic button. */
  byHotkey: boolean;
  /** Bumped when what was said is to go at once, as the hotkey sends it. */
  sendSignal: number;
  onTalk: () => void;
  onTalkSend: () => void;
  onTalkCancel: () => void;
}) {
  const key = useDashboardKey();
  const chats = useQuery(api.dashboard.listChats, { key });
  const chat = useQuery(api.dashboard.getChat, chatId ? { key, id: chatId } : "skip");
  const { results } = usePaginatedQuery(api.dashboard.getChatMessages, chatId ? { key, id: chatId } : "skip", { initialNumItems: 30 });
  const messages = useMemo(() => [...results].sort((a, b) => a.createdAt - b.createdAt), [results]);
  const createChat = useMutation(api.dashboard.createChat);
  const sendChat = useMutation(api.dashboard.sendChat);
  const stopChat = useMutation(api.dashboard.stopChat);
  const markSeen = useMutation(api.dashboard.markChatSeen);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // A chat that was deleted in the dashboard is let go of.
  useEffect(() => {
    if (chatId && chats && !chats.some((item) => item.id === chatId)) onChatId(null);
  }, [chatId, chats, onChatId]);
  // Open here, what it says is seen, as in the dashboard.
  useEffect(() => {
    if (chatId && chat && !chat.isRunning) void markSeen({ key, id: chatId }).catch(() => {});
  }, [chatId, chat, key, markSeen]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [chatId, messages.length, chat?.streaming, chat?.isRunning]);
  useEffect(() => { input.current?.focus(); }, [chatId]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    try {
      const id = chatId ?? await createChat({ key });
      if (!chatId) onChatId(id);
      onDraft("");
      await sendChat({ key, id, text });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSending(false);
    }
  };
  // What was said with the hotkey goes as soon as it is written down.
  const sent = useRef(sendSignal);
  useEffect(() => {
    if (sendSignal === sent.current) return;
    sent.current = sendSignal;
    void send();
    // Only a new signal sends; send itself changes with every keystroke.
  }, [sendSignal]);
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  // Your chats, as the dashboard's sidebar lists them; a schedule's chat is read there.
  const yours = (chats ?? []).filter((item) => !item.jobId).slice(0, 8);
  const title = chatId ? chats?.find((item) => item.id === chatId)?.title ?? chat?.title ?? "Chat" : "New chat";
  const running = Boolean(chat?.isRunning);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative flex items-center gap-0.5 border-b px-2.5 pb-1.5">
        <button type="button" onClick={() => setPicking((value) => !value)} aria-expanded={picking}
          className="flex min-w-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[13px] font-medium hover:bg-muted">
          <span className="truncate">{title}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
        <span className="flex-1" />
        <button type="button" title="New chat" aria-label="New chat" onClick={() => { onChatId(null); setPicking(false); }}
          className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
          <PlusIcon className="size-4" aria-hidden />
        </button>
        {chatId && (
          <button type="button" title="Open in Perry" aria-label="Open this chat in Perry" onClick={() => open(`/chat/${chatId}`)}
            className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
            <ExternalLinkIcon className="size-3.5" aria-hidden />
          </button>
        )}
        {picking && (
          <ul className="absolute top-full left-2.5 z-10 mt-0.5 max-h-64 w-[250px] overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-lg" aria-label="Your chats">
            {yours.length === 0 && <li className="px-2.5 py-2 text-[13px] text-muted-foreground">No chats yet.</li>}
            {yours.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => { onChatId(item.id); setPicking(false); }}
                  className={cn("flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] hover:bg-muted", item.id === chatId && "bg-muted")}>
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  {item.status === "running" && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-label="Working" />}
                  {item.status === "needs-approval" && <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-label="Needs you" />}
                  {item.unseen && item.status === "idle" && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="New" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 pt-3 pb-2 [scrollbar-width:thin] [&_.prose-chat]:text-[13.5px] [&_.prose-chat]:leading-[1.6]" aria-live="polite">
        {!chatId && (<div className="flex min-h-full flex-col justify-center pb-3">
          <Empty title="What can I do for you?" awake className="pt-0">
            {voice && hotkey ? <>Type, or hold <kbd className="rounded border bg-muted px-1 font-mono text-[11px]">{keys(hotkey)}</kbd> anywhere and talk.</> : "I know your chats and memory, and work on this computer."}
          </Empty>
          <div className="flex flex-wrap justify-center gap-1.5 px-2">
            {SUGGESTIONS.map((text) => (
              <button key={text} type="button" onClick={() => { onDraft(text); input.current?.focus(); }}
                className="cursor-pointer rounded-full border bg-background px-3 py-1 text-[12.5px] text-foreground/85 transition-colors hover:border-primary/40 hover:bg-brand-soft">
                {text}
              </button>
            ))}
          </div>
        </div>)}
        {messages.map((message) => message.role === "user" ? (
          <p key={message.id} className={cn("ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-muted px-3 py-1.5 text-[13.5px] whitespace-pre-wrap [overflow-wrap:anywhere]", message.pending && "opacity-70")}>
            {message.text}
          </p>
        ) : (
          <div key={message.id}><Markdown text={message.text} /></div>
        ))}
        {running && (chat?.streaming
          ? <div className="opacity-90"><Markdown text={chat.streaming} /></div>
          : <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground"><span className="size-1.5 animate-pulse rounded-full bg-primary" />Working…</p>)}
        {chat?.lastError && !running && <p className="text-[12.5px] text-destructive">{chat.lastError}</p>}
      </div>

      <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="px-3 pt-1 pb-3">
        <div className="flex items-end gap-1.5 rounded-2xl border bg-card py-1.5 pr-1.5 pl-3 shadow-[0_1px_2px_rgb(0_0_0/0.05)] transition-colors focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/15">
          {voice && voice.state !== "idle" ? (
            <div className="min-w-0 flex-1"><Listening voice={voice} onSend={onTalkSend} onCancel={onTalkCancel} /></div>
          ) : (<>
          <textarea
            ref={input}
            value={draft}
            rows={1}
            onChange={(event) => { onDraft(event.target.value); setError(""); }}
            onKeyDown={onKey}
            aria-label="Message Perry"
            placeholder={running ? "Add to what he's doing…" : "Ask Perry, or tell him what to do"}
            className="max-h-28 min-h-7 flex-1 resize-none bg-transparent py-1 text-[13.5px] outline-none [field-sizing:content] placeholder:text-muted-foreground/80"
          />
          {voice && <MicButton onClick={onTalk} />}
          {running && !draft.trim() ? (
            <button type="button" aria-label="Stop" title="Stop" onClick={() => chatId && void stopChat({ key, id: chatId })}
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-full bg-foreground text-background">
              <SquareIcon className="size-3 fill-current" aria-hidden />
            </button>
          ) : (
            <button type="submit" aria-label="Send" disabled={!draft.trim() || sending}
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-full bg-primary text-primary-foreground disabled:cursor-default disabled:opacity-40">
              <ArrowUpIcon className="size-4" aria-hidden />
            </button>
          )}
          </>)}
        </div>
        {voice?.state === "listening" && (
          <p className="mt-1 px-1 text-[11.5px] text-muted-foreground">
            {byHotkey && hotkey ? `Listening. Let go of ${keys(hotkey)}, or press it again, to send; Esc to stop.` : "Listening. Send when you're done, and it goes into the box to check; Esc to stop."}
          </p>
        )}
        {(error || voice?.error) && <p className="mt-1 px-1 text-[12px] text-destructive">{error || voice?.error}</p>}
      </form>
    </div>
  );
}

/** What a new chat offers to start with; a click puts it in the box, to send or change. */
const SUGGESTIONS = ["What’s on my list today?", "Remind me to stretch every day at 11", "What did we talk about yesterday?"];

/** A hotkey as this computer's keyboard names it: "Ctrl+Shift+Space", "⇧⌘Space". */
function keys(hotkey: string): string {
  return describe(hotkey, typeof navigator !== "undefined" && /Mac/.test(navigator.platform));
}
