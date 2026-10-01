"use client";

import { ArrowUpIcon, ChevronDownIcon, ExternalLinkIcon, PlusIcon, ScanEyeIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorText } from "@/lib/format";
import { useDashboardKey } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Markdown } from "@/components/dashboard/chat/markdown";
import { StatusIndicator } from "@/components/dashboard/status-indicator";
import { describe, holdProblem } from "@/convex/lib/shortcuts";
import { Empty } from "./empty";
import { PetTip } from "./tip";
import { Listening, MicButton, type Voice } from "./voice";

/**
 * The pet's chat: one of your chats with Perry, the same one the dashboard
 * shows, with the same memory and everything Perry knows. Pick another from
 * the list, start a new one, or open it in the dashboard for the rest (files,
 * models, branching).
 *
 * A picture of the screen (his Look hotkey, or the eye button) waits above the
 * box, to check, switch between the window and the whole screen, or take
 * away, and goes with the next message.
 */

export type PetChatId = Id<"conversations"> | null;
type Picture = { name: string; image: string };
/** What his window took (pet/look.js): the window the owner was in, the whole screen, or why neither; `needs` a permission macOS has not given. */
export type TakenShot = { window?: Picture; screen?: Picture; error?: string; needs?: "screen-recording" };
/** A picture waiting to be sent, and which of the two goes. */
export type Shot = TakenShot & { use: "window" | "screen" };

/** Keep a picture of the screen on this computer, as the dashboard keeps a file you attach: where it is, and what it is called. */
export async function keepPicture(image: string): Promise<{ path: string; fileName: string; size: number }> {
  const file = await (await fetch(image)).blob();
  const fileName = `screen-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
  const saved = await fetch("/api/media", { method: "POST", headers: { "x-file-name": fileName }, body: file });
  const body = await saved.json().catch(() => null) as { path?: string; error?: string } | null;
  if (!saved.ok || !body?.path) throw new Error(body?.error ?? "Could not keep the picture of the screen.");
  return { path: body.path, fileName, size: file.size };
}

export function PetChat({ chatId, onChatId, draft, onDraft, open, voice, hotkey, hold, byHotkey, sendSignal, onTalk, onTalkSend, onTalkCancel, shot, onShot, onLook, lookKeys }: {
  chatId: PetChatId;
  onChatId: (id: PetChatId) => void;
  draft: string;
  onDraft: (text: string) => void;
  open: (path: string) => void;
  /** Talking to him, where his window can hear (not in a plain browser). */
  voice?: Voice;
  hotkey?: string | null;
  /** Why the hotkey can only be tapped, where holding it does not work (pet/voice.js). */
  hold?: string | null;
  /** Whether he is listening because of the hotkey, which is let go of to send, or the mic button. */
  byHotkey: boolean;
  /** Bumped when what was said is to go at once, as the hotkey sends it. */
  sendSignal: number;
  onTalk: () => void;
  onTalkSend: () => void;
  onTalkCancel: () => void;
  shot: Shot | null;
  onShot: (shot: Shot | null) => void;
  /** Take a picture of the screen, where his window can (not in a plain browser). */
  onLook?: () => void;
  lookKeys?: string | null;
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
  const registerAttachment = useMutation(api.dashboard.registerAttachment);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  /** What scrolls: the ScrollArea's viewport, kept at the newest message. */
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

  const picture = shot ? shot[shot.use] ?? null : null;
  const send = async () => {
    const text = draft.trim();
    if ((!text && !picture) || sending) return;
    setSending(true);
    setError("");
    try {
      const id = chatId ?? await createChat({ key });
      if (!chatId) onChatId(id);
      // The picture is kept on this computer as the dashboard keeps a file you attach, and goes with the message.
      const messageKey = crypto.randomUUID();
      const attachmentIds = picture ? [await attach(id, messageKey, picture)] : [];
      onDraft("");
      onShot(null);
      await sendChat({ key, id, text, ...(attachmentIds.length ? { attachmentIds, messageKey } : {}) });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSending(false);
    }
  };
  const attach = async (id: Id<"conversations">, messageKey: string, { image }: Picture) => {
    const { path, fileName, size } = await keepPicture(image);
    return await registerAttachment({ key, conversationId: id, messageKey, localPath: path, fileName, contentType: "image/png", size });
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
      <div className="flex items-center gap-0.5 border-b px-2.5 pb-1.5">
        {/* Your chats, as a menu: arrow keys, Esc and a click outside close it; data-solid, or the window would let its clicks through. */}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="min-w-0 px-1.5 text-sm" aria-label={`${title}: pick a chat`} />}>
            <span className="truncate">{title}</span>
            <ChevronDownIcon className="text-muted-foreground" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent data-solid align="start" className="max-h-64 w-[250px]" aria-label="Your chats">
            {yours.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">No chats yet.</p>}
            <DropdownMenuRadioGroup value={chatId ?? ""} onValueChange={(id) => onChatId(id as Id<"conversations">)}>
              {yours.map((item) => (
                <DropdownMenuRadioItem key={item.id} value={item.id} closeOnClick className="gap-2">
                  <span className={cn("min-w-0 flex-1 truncate", item.naming && "shimmer")}>{item.title}</span>
                  <StatusIndicator status={item.status} unseen={item.unseen && item.id !== chatId} />
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="flex-1" />
        <PetTip label="New chat">
          <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="New chat" onClick={() => onChatId(null)}><PlusIcon /></Button>
        </PetTip>
        {chatId && (
          <PetTip label="Open in Perry">
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Open this chat in Perry" onClick={() => open(`/chat/${chatId}`)}><ExternalLinkIcon /></Button>
          </PetTip>
        )}
      </div>

      <ScrollArea viewportRef={scroller} className="min-h-0 flex-1">
      <div className="flex min-h-full flex-col space-y-3 px-3.5 pt-3 pb-2 [&_.prose-chat]:text-sm [&_.prose-chat]:leading-[1.6]" aria-live="polite">
        {!chatId && (<div className="flex flex-1 flex-col justify-center pb-3">
          <Empty title="What can I do for you?" awake className="pt-0">
            {voice && hotkey ? (holdProblem(hold)
              ? <>Type, or tap <Kbd>{keys(hotkey)}</Kbd> anywhere, talk, and tap it again.</>
              : <>Type, or hold <Kbd>{keys(hotkey)}</Kbd> anywhere and talk.</>)
              : null}
          </Empty>
          <div className="flex flex-wrap justify-center gap-1.5 px-2">
            {SUGGESTIONS.map((text) => (
              <Button key={text} variant="outline" size="sm" className="rounded-full px-3 font-normal text-foreground/85 hover:border-primary/40 hover:bg-brand-soft"
                onClick={() => { onDraft(text); input.current?.focus(); }}>
                {text}
              </Button>
            ))}
          </div>
        </div>)}
        {messages.map((message) => message.role === "user" ? (
          <div key={message.id} className="ml-auto flex w-fit max-w-[85%] flex-col items-end gap-1" data-role="user">
            {message.attachments.filter((file) => file.contentType.startsWith("image/")).map((file) => (
              // eslint-disable-next-line @next/next/no-img-element -- a local file served by /api/media, not a static asset
              <img key={file.url} src={file.url} alt={file.fileName} className="max-h-32 rounded-xl border object-contain" />
            ))}
            {message.text && (
              <p className={cn("w-fit rounded-2xl rounded-br-md bg-muted px-3 py-1.5 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]", message.pending && "opacity-70")}>
                {message.text}
              </p>
            )}
          </div>
        ) : (
          <div key={message.id}><Markdown text={message.text} /></div>
        ))}
        {running && (chat?.streaming
          ? <div className="opacity-90"><Markdown text={chat.streaming} /></div>
          : <p className="flex items-center gap-1.5 text-sm text-muted-foreground"><span className="size-1.5 animate-pulse rounded-full bg-primary" />Working…</p>)}
        {chat?.lastError && !running && <p className="text-xs text-destructive">{chat.lastError}</p>}
      </div>
      </ScrollArea>

      <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="px-3 pt-1 pb-3">
        {shot && picture && (
          <div className="mb-1.5 flex items-start gap-2 px-1.5" aria-label="Picture of the screen to send">
            {/* eslint-disable-next-line @next/next/no-img-element -- a picture just taken, as a data URL */}
            <img src={picture.image} alt={`Picture of ${picture.name}`} className="h-16 max-w-28 shrink-0 rounded-md border object-cover object-top" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium" title={picture.name}>{picture.name}</p>
              <p className="text-2xs text-muted-foreground">Goes with your next message.</p>
              {shot.window && shot.screen && (
                <ToggleGroup aria-label="Which picture" value={[shot.use]} onValueChange={(next) => { if (next[0]) onShot({ ...shot, use: next[0] as Shot["use"] }); }}
                  variant="outline" size="sm" spacing={1} className="mt-1">
                  {(["window", "screen"] as const).map((use) => (
                    <ToggleGroupItem key={use} value={use} className="h-6 min-w-0 rounded-full px-2 text-xs font-normal text-muted-foreground aria-pressed:border-primary/50 aria-pressed:bg-brand-soft aria-pressed:text-foreground">
                      {use === "window" ? "This window" : "Whole screen"}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}
            </div>
            <PetTip label="Don't send it">
              <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Don't send the picture" onClick={() => onShot(null)}><XIcon /></Button>
            </PetTip>
          </div>
        )}
        {voice && voice.state !== "idle" ? (
          <div className="rounded-2xl border bg-card py-1.5 pr-1.5 pl-3 shadow-raised"><Listening voice={voice} onSend={onTalkSend} onCancel={onTalkCancel} /></div>
        ) : (
          <InputGroup className="rounded-2xl bg-card shadow-raised dark:bg-card">
            <InputGroupTextarea
              ref={input}
              value={draft}
              rows={1}
              onChange={(event) => { onDraft(event.target.value); setError(""); }}
              onKeyDown={onKey}
              aria-label="Message Perry"
              placeholder={picture ? "Ask about it, or just send" : running ? "Add to what he's doing…" : "Message Perry"}
              className="max-h-28 min-h-9 py-2 pl-3 text-sm md:text-sm"
            />
            <InputGroupAddon align="inline-end" className="gap-1 self-end pb-1.5">
              {onLook && (
                <PetTip label={`Show him the window you're in${lookKeys ? ` (${keys(lookKeys)} from anywhere)` : ""}`}>
                  <InputGroupButton size="icon-xs" className="size-7 rounded-full text-muted-foreground" onClick={onLook} aria-label="Show Perry the screen"><ScanEyeIcon className="size-4" /></InputGroupButton>
                </PetTip>
              )}
              {voice && <MicButton onClick={onTalk} />}
              {running && !draft.trim() && !picture ? (
                <PetTip label="Stop">
                  <InputGroupButton size="icon-xs" variant="default" className="size-7 rounded-full bg-foreground text-background hover:bg-foreground/80" aria-label="Stop"
                    onClick={() => chatId && void stopChat({ key, id: chatId })}>
                    <SquareIcon className="size-3 fill-current" />
                  </InputGroupButton>
                </PetTip>
              ) : (
                <InputGroupButton type="submit" size="icon-xs" variant={!draft.trim() && !picture ? "secondary" : "default"} className={cn("size-7 rounded-full", !draft.trim() && !picture && "text-muted-foreground disabled:opacity-100")} aria-label="Send" disabled={(!draft.trim() && !picture) || sending}>
                  <ArrowUpIcon className="size-4" />
                </InputGroupButton>
              )}
            </InputGroupAddon>
          </InputGroup>
        )}
        {voice?.state === "listening" && (
          <p className="mt-1 px-1 text-2xs text-muted-foreground">
            {!byHotkey || !hotkey ? "Listening. Send when you're done; Esc to stop."
              : holdProblem(hold) ? `Listening. Press ${keys(hotkey)} again to send; Esc to stop. ${holdProblem(hold)}`
                : `Listening. Let go of ${keys(hotkey)} to send; Esc to stop.`}
          </p>
        )}
        {(error || voice?.error) && <p className="mt-1 px-1 text-xs text-destructive">{error || voice?.error}</p>}
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
