"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  ActivityIcon, ArrowDownIcon, CopyIcon, GitBranchIcon, MoreHorizontalIcon, PencilIcon, PinIcon, PinOffIcon, RefreshCwIcon,
  SquarePenIcon, Trash2Icon, TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useAction, useMutation, usePaginatedQuery, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  ACCESS_HINTS, ACCESS_LABELS, ACCESSES, COMPACTED, chatModel, describeAccess, describeEfforts, describeModels, effortUnused, findModel,
  parseAccessCommand, parseModelCommand, parseThinkCommand, pickAccess, pickEffort, pickModel, type Access,
} from "@/convex/lib/commands";
import { copyText, errorText, useNow } from "@/lib/format";
import { ACTIVE_CHAT, useSession } from "@/lib/session";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ApprovalCard } from "../approval-card";
import { DeleteDialog, RenameDialog } from "../app-sidebar";
import { PerryMark, TopBar } from "../common";
import { StatusDot } from "../status-dot";
import type { Attachment } from "./attachments";
import { Composer, ComposerNote, MAX_BYTES, MAX_FILES, levelName, type Suggestion } from "./composer";
import { MessageRow, PendingRow, ReplyInProgress } from "./message";

type ChatId = Id<"conversations">;
type PendingAttachment = Attachment & { id: Id<"chatAttachments"> };
/**
 * A message you sent, shown before the server has it: `sent` once sendChat
 * returns, after which the server lists it as pending until its reply saves it.
 */
type Pending = { id: ChatId; text: string; attachments: Attachment[]; baselineCount: number; seenRunning: boolean; sent: boolean };

const STARTERS = [
  "Plan my day",
  "What did we work on this week?",
  "Help me think through an idea",
];

const COMMANDS = [
  { command: "/model", hint: "List the models, or /model <name> to switch this chat" },
  { command: "/think", hint: "List the thinking levels, or /think <level>" },
  { command: "/access", hint: "Ask, Auto or Full access: whether it asks before acting" },
  { command: "/stop", hint: "Stop the reply being written" },
  { command: "/compact", hint: "Shrink what Codex carries of this chat; the messages stay" },
  { command: "/reset", hint: "Save this chat to memory, then start it afresh" },
];

function greeting(name?: string) {
  const hour = new Date().getHours();
  const part = hour < 5 ? "Up late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}` : part;
}

/** Keep the file on this machine, through the local media server. */
async function store(file: File): Promise<{ localPath: string }> {
  const local = await fetch("/api/media", { method: "POST", headers: { "x-file-name": encodeURIComponent(file.name) }, body: file });
  if (local.ok) return { localPath: (await local.json() as { path: string }).path };
  throw new Error((await local.json().catch(() => null) as { error?: string } | null)?.error ?? `Could not save ${file.name}.`);
}

export function ChatScreen() {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const paramId = (params.id ? decodeURIComponent(params.id) : null) as ChatId | null;
  /** A chat made from /chat by its first message, until the address catches up. */
  const [createdId, setCreatedId] = useState<ChatId | null>(null);
  useEffect(() => setCreatedId(null), [paramId]);
  const selectedId = paramId ?? createdId;

  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  const assistant = status?.assistantName ?? "Perry";
  const chats = useQuery(api.dashboard.listChats, { key: dashboardKey });
  const summary = chats?.find((item) => item.id === selectedId);
  const parent = chats?.find((item) => item.id === summary?.parentConversationId);
  const chat = useQuery(api.dashboard.getChat, selectedId ? { key: dashboardKey, id: selectedId } : "skip");
  const { results: newest, status: messageStatus, loadMore } = usePaginatedQuery(
    api.dashboard.getChatMessages,
    selectedId ? { key: dashboardKey, id: selectedId } : "skip",
    { initialNumItems: 50 },
  );
  const messages = useMemo(() => [...newest].sort((a, b) => a.createdAt - b.createdAt), [newest]);
  const approvals = useQuery(api.approvals.pending, { key: dashboardKey });
  const now = useNow(1000);
  const here = (approvals ?? []).filter((item) => item.chat?.id === selectedId && item.expiresAt > now);

  const createChat = useMutation(api.dashboard.createChat);
  const sendChat = useMutation(api.dashboard.sendChat);
  const stopChat = useMutation(api.dashboard.stopChat);
  const compactChat = useMutation(api.dashboard.compactChat);
  const registerAttachment = useMutation(api.dashboard.registerAttachment);
  const markSeen = useMutation(api.dashboard.markChatSeen);
  const skipOnboarding = useMutation(api.dashboard.skipOnboarding);
  const redoOnboarding = useMutation(api.dashboard.redoOnboarding);
  const branchChat = useAction(api.dashboard.branchChat);
  const rewindChat = useAction(api.dashboard.rewindChat);
  const resetChat = useAction(api.dashboard.resetChat);
  const setPinned = useMutation(api.dashboard.setChatPinned);
  const modelOptions = useQuery(api.models.options, { key: dashboardKey });
  const defaultAccess = useQuery(api.dashboard.getDefaultAccess, { key: dashboardKey });
  const lastPicks = useQuery(api.dashboard.getLastPicks, { key: dashboardKey });
  const setChatModel = useMutation(api.dashboard.setChatModel).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.dashboard.getChat, { key: args.key, id: args.id });
    if (current) store.setQuery(api.dashboard.getChat, { key: args.key, id: args.id }, { ...current, model: args.model });
  });
  const setChatEffort = useMutation(api.dashboard.setChatEffort).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.dashboard.getChat, { key: args.key, id: args.id });
    if (current) store.setQuery(api.dashboard.getChat, { key: args.key, id: args.id }, { ...current, effort: args.effort });
  });
  const setChatAccess = useMutation(api.dashboard.setChatAccess).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.dashboard.getChat, { key: args.key, id: args.id });
    if (current) store.setQuery(api.dashboard.getChat, { key: args.key, id: args.id }, { ...current, access: args.access });
  });

  /**
   * What was picked for a chat not sent yet. Unset carries over the last chat's model and level
   * (and the default access); "" is the default model or level, picked on purpose.
   */
  const [draftModel, setDraftModel] = useState<string>();
  const [draftEffort, setDraftEffort] = useState<string>();
  const [draftAccess, setDraftAccess] = useState<Access>();
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  /** The /compact being waited on, to say when it is done. */
  const [compaction, setCompaction] = useState<Id<"codexTurns"> | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState<{ index: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const compactionStatus = useQuery(api.dashboard.getCompaction, compaction ? { key: dashboardKey, id: compaction } : "skip");

  // Remember the open chat, for the next visit to the root.
  useEffect(() => { if (paramId) window.localStorage.setItem(ACTIVE_CHAT, paramId); }, [paramId]);
  useEffect(() => { document.title = summary?.title ? `${summary.title} · Perry` : selectedId ? "Perry" : "New chat · Perry"; }, [summary?.title, selectedId]);
  // A new chat, or another one, starts with a clean composer state.
  useEffect(() => {
    setError(""); setNotice("");
    if (!paramId) window.setTimeout(() => composer.current?.focus(), 0);
  }, [paramId]);
  // Needs you starts an answer here with ?draft=, which is taken in, then out of the address.
  const handed = useSearchParams().get("draft");
  useEffect(() => {
    if (!handed) return;
    setDraft(handed);
    router.replace("/chat", { scroll: false });
    window.setTimeout(() => composer.current?.focus(), 0);
  }, [handed, router]);

  // What is in an open chat is seen, and so is each reply that lands while it is open and in view.
  useEffect(() => {
    if (!selectedId || !summary?.unseen) return;
    const mark = () => { if (document.visibilityState === "visible") void markSeen({ key: dashboardKey, id: selectedId }).catch(() => {}); };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [selectedId, summary?.unseen, dashboardKey, markSeen]);
  // Opening a chat counts as having seen it, so the first reply after is unseen only if you left.
  useEffect(() => {
    if (selectedId && chat && !chat.isRunning) void markSeen({ key: dashboardKey, id: selectedId }).catch(() => {});
  }, [selectedId, Boolean(chat), chat?.isRunning, dashboardKey, markSeen]);

  // A message you sent stops being shown from here once the server lists it (as pending, or in the history),
  // or once the reply it started or joined has come and gone.
  useEffect(() => {
    setPending((items) => {
      const next = items.filter((item) => item.id !== selectedId
        || messages.filter((message) => message.role === "user" && message.text === item.text).length <= item.baselineCount);
      return next.length === items.length ? items : next;
    });
  }, [messages, selectedId]);
  useEffect(() => {
    const running = chat?.isRunning;
    if (running === undefined) return;
    setPending((items) => {
      let changed = false;
      const next = items.flatMap((item) => {
        if (item.id !== selectedId) return [item];
        if (running && !item.seenRunning) { changed = true; return [{ ...item, seenRunning: true }]; }
        if (item.seenRunning && !running) { changed = true; return []; }
        return [item];
      });
      return changed ? next : items;
    });
  }, [chat?.isRunning, selectedId]);
  useEffect(() => {
    if (!compactionStatus || compactionStatus.status === "queued" || compactionStatus.status === "running") return;
    setNotice(compactionStatus.status === "done" ? COMPACTED : `Could not compact: ${compactionStatus.error ?? "Codex did not say why."}`);
    setCompaction(null);
  }, [compactionStatus]);

  const shownPending = pending.filter((item) => item.id === selectedId);
  const waiting = shownPending.length > 0 || Boolean(chat?.isRunning);

  // Scrolling: a chat opens at its newest message; after that, new content only scrolls into view for a reader already at the bottom.
  const scroller = useRef<HTMLDivElement>(null);
  const olderScroll = useRef<{ height: number; top: number } | null>(null);
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  useLayoutEffect(() => { stick.current = true; setAtBottom(true); }, [selectedId]);
  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    stick.current = bottom;
    setAtBottom(bottom);
  }, []);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (olderScroll.current) {
      element.scrollTop = olderScroll.current.top + element.scrollHeight - olderScroll.current.height;
      olderScroll.current = null;
    } else if (stick.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [selectedId, messages.length, shownPending.length, waiting, chat?.streaming, here.length]);
  const jumpToLatest = () => {
    stick.current = true;
    setAtBottom(true);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  const models = modelOptions?.codex;
  const model = (selectedId ? chat?.model : draftModel ?? lastPicks?.model) || ((models ?? []).find((item) => item.isDefault) ?? models?.[0])?.id;
  // The thinking levels are the model's own; a level it does not take is kept but unused.
  const modelInfo = chatModel(models ?? [], model);
  const efforts = modelInfo?.efforts ?? [];
  const pickedEffort = (selectedId ? chat?.effort : draftEffort ?? lastPicks?.effort) || undefined;
  const effort = modelInfo && effortUnused(modelInfo, pickedEffort) ? undefined : pickedEffort;
  const access: Access = (selectedId ? chat?.access : draftAccess) ?? defaultAccess ?? "supervised";
  const fail = (cause: unknown) => setError(errorText(cause));

  function applyModel(next: string) {
    const picked = models?.find((item) => item.id === next);
    if (picked && pickedEffort && effortUnused(picked, pickedEffort)) {
      setNotice(`${picked.name} doesn't take the ${pickedEffort} thinking level, so it thinks at its default here.`);
    }
    if (!selectedId) return setDraftModel(next);
    void setChatModel({ key: dashboardKey, id: selectedId, model: next || undefined }).catch(fail);
  }
  function applyEffort(next: string | undefined) {
    if (!selectedId) return setDraftEffort(next ?? "");
    void setChatEffort({ key: dashboardKey, id: selectedId, effort: next }).catch(fail);
  }
  function applyAccess(next: Access) {
    if (!selectedId) return setDraftAccess(next);
    void setChatAccess({ key: dashboardKey, id: selectedId, access: next }).catch(fail);
  }

  /** Add files from the picker, a paste or a drop, turning away what cannot be sent. */
  function addFiles(added: File[]) {
    if (!added.length) return;
    const tooBig = added.filter((file) => file.size > MAX_BYTES);
    const empty = added.filter((file) => file.size === 0);
    const usable = added.filter((file) => file.size > 0 && file.size <= MAX_BYTES);
    const left = usable.length - Math.max(0, MAX_FILES - files.length);
    const problems = [
      tooBig.length ? `${tooBig.map((file) => file.name).join(", ")} ${tooBig.length === 1 ? "is" : "are"} over 50 MB.` : "",
      empty.length ? `${empty.map((file) => file.name).join(", ")} ${empty.length === 1 ? "is" : "are"} empty.` : "",
      left > 0 ? `Only ${MAX_FILES} files fit in one message, so ${left} ${left === 1 ? "was" : "were"} left out.` : "",
    ].filter(Boolean);
    if (problems.length) setError(problems.join(" "));
    setFiles((items) => [...items, ...usable].slice(0, MAX_FILES));
  }

  // Slash commands: past a command's name, the suggestions are its choices.
  const typedModel = parseModelCommand(draft);
  const typedThink = parseThinkCommand(draft);
  const typedAccess = parseAccessCommand(draft);
  const choosing = /^\/(?:(?:set\s+)?model|think|access)\s/i.test(draft);
  const choices = (options: Array<{ value: string; label: string; hint: string }>, typed: string | undefined, command: string): Suggestion[] =>
    options.filter((option) => !typed || option.value.startsWith(typed)).map((option) => ({
      key: option.value, label: option.label, hint: option.hint, apply: () => void runCommand(`${command} ${option.value}`),
    }));
  const suggestions: Suggestion[] = !draft.startsWith("/")
    ? []
    : typedModel && choosing
      ? (typedModel.name ? findModel(models ?? [], typedModel.name).matches : models ?? []).map((item) => ({
          key: item.id, label: item.name, hint: `${item.id}${item.id === model ? " · current" : ""}${item.isDefault ? " · default" : ""}`,
          apply: () => void runCommand(`/model ${item.id}`),
        }))
      : typedThink && choosing
        ? choices([
            { value: "default", label: "Default", hint: `${modelInfo?.defaultEffort ?? "the model's own"}${effort ? "" : " · current"}` },
            ...efforts.map((level) => ({ value: level, label: levelName(level), hint: `${level}${level === effort ? " · current" : ""}` })),
          ], typedThink.level, "/think")
        : typedAccess && choosing
          ? choices(ACCESSES.map((mode) => ({ value: mode, label: ACCESS_LABELS[mode], hint: `${ACCESS_HINTS[mode]}${mode === access ? " · current" : ""}` })), typedAccess.mode, "/access")
          : COMMANDS.filter((item) => item.command.startsWith(draft.trim().toLowerCase()) && draft.trim().length <= item.command.length).map((item) => ({
              key: item.command, label: item.command, hint: item.hint,
              apply: () => { setDraft(["/stop", "/compact", "/reset"].includes(item.command) ? item.command : `${item.command} `); composer.current?.focus(); },
            }));
  const completing = draft.startsWith("/") && !choosing
    ? "command" as const
    : choosing && !typedModel && suggestions.length > 0 && !suggestions.some((item) => item.key === (typedThink?.level ?? typedAccess?.mode))
      ? "choice" as const
      : null;

  /** Commands never become messages: they change this chat, then say what they did. */
  async function runCommand(text: string): Promise<boolean> {
    const trimmed = text.trim();
    const modelCommand = parseModelCommand(trimmed);
    if (modelCommand) {
      if (!modelCommand.name) { setDraft(""); setNotice(describeModels(models ?? [], model)); return true; }
      const picked = pickModel(models ?? [], modelCommand.name, pickedEffort);
      // A name that matched nothing, or several models, stays in the box to be fixed.
      if (picked.model) { applyModel(picked.model.id); setDraft(""); }
      setNotice(picked.reply);
      return true;
    }
    const thinkCommand = parseThinkCommand(trimmed);
    if (thinkCommand) {
      if (!thinkCommand.level) { setDraft(""); setNotice(describeEfforts(models ?? [], model, pickedEffort)); return true; }
      const picked = pickEffort(models ?? [], model, thinkCommand.level);
      if (picked.ok) { applyEffort(picked.effort); setDraft(""); }
      setNotice(picked.reply);
      return true;
    }
    const accessCommand = parseAccessCommand(trimmed);
    if (accessCommand) {
      if (!accessCommand.mode) { setDraft(""); setNotice(describeAccess(access)); return true; }
      const picked = pickAccess(accessCommand.mode);
      if (picked.access) { applyAccess(picked.access); setDraft(""); }
      setNotice(picked.reply);
      return true;
    }
    const command = trimmed.toLowerCase();
    if (command === "/stop") {
      setDraft("");
      if (selectedId && waiting) await stopChat({ key: dashboardKey, id: selectedId });
      setNotice(selectedId && waiting ? "Stopping." : "Nothing is running.");
      return true;
    }
    if (command === "/reset") {
      setDraft("");
      if (!selectedId) { setNotice("Nothing to reset yet."); return true; }
      setNotice("Saving this chat to memory and starting it afresh…");
      try { setNotice(await resetChat({ key: dashboardKey, id: selectedId })); } catch (cause) { setNotice(""); fail(cause); }
      return true;
    }
    if (command === "/compact") {
      setDraft("");
      try {
        const id = selectedId ? await compactChat({ key: dashboardKey, id: selectedId }) : null;
        setCompaction(id);
        setNotice(id ? "Compacting this chat…" : "Nothing to compact yet.");
      } catch (cause) { setNotice(errorText(cause)); }
      return true;
    }
    return false;
  }

  async function submit(text = draft) {
    const message = text.trim();
    if (message.startsWith("/") && files.length === 0 && await runCommand(message)) return;
    // Sent while a reply is running, the message joins that reply (it steers it).
    if ((!message && files.length === 0) || busy || uploading) return;
    const fresh = !selectedId;
    let id = selectedId;
    if (!id) {
      setBusy(true);
      try {
        id = await createChat({ key: dashboardKey });
        setCreatedId(id);
        // The chat has its own address from now, so a reload while it sends comes back to it.
        router.replace(`/chat/${id}`);
      } catch (cause) {
        fail(cause);
        return;
      } finally {
        setBusy(false);
      }
    }
    const sending = files;
    const messageKey = sending.length ? crypto.randomUUID() : undefined;
    setDraft(""); setFiles([]); setError(""); setNotice("");
    stick.current = true;
    let sent: Pending | undefined;
    try {
      const uploaded: PendingAttachment[] = [];
      for (const [index, file] of sending.entries()) {
        setUploading({ index: index + 1, total: sending.length });
        const contentType = file.type || "application/octet-stream";
        const attachmentId = await registerAttachment({ key: dashboardKey, conversationId: id, messageKey: messageKey!, ...await store(file), fileName: file.name, contentType, size: file.size });
        uploaded.push({ id: attachmentId, url: URL.createObjectURL(file), fileName: file.name, contentType });
      }
      setUploading(null);
      sent = {
        id, text: message, attachments: uploaded,
        baselineCount: fresh ? 0 : messages.filter((item) => item.role === "user" && item.text === message).length,
        seenRunning: !fresh && Boolean(chat?.isRunning), sent: false,
      };
      const entry = sent;
      setPending((items) => [...items, entry]);
      // A new chat takes what was picked before it existed; an existing one already has its own.
      await sendChat({
        key: dashboardKey, id, text: message, attachmentIds: uploaded.map((item) => item.id), messageKey, model,
        ...(fresh ? { effort: pickedEffort ?? "", access: draftAccess } : {}),
      });
      setPending((items) => items.map((item) => item === entry ? { ...item, sent: true } : item));
      // Full access is chosen for a chat, never carried into the next new one.
      if (fresh) setDraftAccess(undefined);
    } catch (cause) {
      setUploading(null);
      setPending((items) => items.filter((item) => item !== sent));
      setDraft(message); setFiles(sending);
      setError(`Your message wasn't sent: ${errorText(cause)}`);
    }
  }

  /** Regenerate from an assistant reply, or resend one of your messages with new text. */
  async function rewind(messageId: string, text?: string) {
    if (!selectedId || busy || waiting) return;
    const index = messages.findIndex((message) => message.id === messageId);
    const source = [...messages.slice(0, index + 1)].reverse().find((message) => message.role === "user");
    const shown = text ?? source?.text ?? "";
    setBusy(true); setError("");
    stick.current = true;
    // The copy being replaced is removed before the new one is listed, so it is not part of the baseline.
    const entry: Pending = {
      id: selectedId, text: shown, attachments: source?.attachments ?? [], seenRunning: false, sent: true,
      baselineCount: messages.filter((message) => message.role === "user" && message.text === shown).length - (source?.text === shown ? 1 : 0),
    };
    try {
      setPending((items) => [...items, entry]);
      await rewindChat({ key: dashboardKey, id: selectedId, messageId, text });
    } catch (cause) {
      setPending((items) => items.filter((item) => item !== entry));
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  async function branch(messageId: string) {
    if (!selectedId || busy) return;
    setBusy(true); setError("");
    try {
      const id = await branchChat({ key: dashboardKey, id: selectedId, messageId });
      router.push(`/chat/${id}`);
      toast.success("Branched into a new chat.");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }

  const stop = () => { if (selectedId) void stopChat({ key: dashboardKey, id: selectedId }).catch(fail); };
  // Only what is in the history can be regenerated, edited or branched from.
  const saved = messages.filter((message) => !message.pending);
  const lastUser = [...saved].reverse().find((message) => message.role === "user");
  const lastMessage = saved.at(-1);
  const loading = Boolean(selectedId) && (chat === undefined || messageStatus === "LoadingFirstPage");
  const missing = Boolean(selectedId) && chat === null;
  const title = summary?.title ?? (selectedId ? chat?.title ?? "" : "New chat");

  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <TopBar actions={selectedId && summary ? (
        <ChatMenu
          pinned={summary.pinned}
          onPin={() => void setPinned({ key: dashboardKey, id: summary.id, pinned: !summary.pinned }).catch(fail)}
          onRename={() => setRenaming(true)}
          onCopyId={() => void copyText(summary.id).then(() => toast.success("Session ID copied."), fail)}
          activityHref={`/activity?session=${summary.id}`}
          onDelete={() => setRemoving(true)}
        />
      ) : !selectedId ? null : undefined}>
        <h1 className="min-w-0 truncate text-sm font-medium">{title}</h1>
        {summary && <StatusDot status={summary.status} />}
        {parent && (
          <Link href={`/chat/${parent.id}`} className="hidden min-w-0 items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground sm:flex">
            <GitBranchIcon className="size-3 shrink-0" />from {parent.title}
          </Link>
        )}
      </TopBar>

      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]" id="content" tabIndex={-1}>
        <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
          {status?.onboarding === "offer" && (
            <Alert className="mt-4">
              <AlertTitle>Tell {assistant} about yourself</AlertTitle>
              <AlertDescription>A name, a personality, and a page about you that {assistant} reads before every reply. About two minutes.</AlertDescription>
              <AlertAction className="flex gap-2">
                <Button size="sm" variant="ghost" onClick={() => void skipOnboarding({ key: dashboardKey }).catch(fail)}>Not now</Button>
                <Button size="sm" onClick={() => void redoOnboarding({ key: dashboardKey }).then(() => router.push("/welcome"), fail)}>Start</Button>
              </AlertAction>
            </Alert>
          )}

          {!selectedId ? (
            <div className="flex min-h-[calc(100dvh-16rem)] flex-col items-center justify-center py-12 text-center">
              <PerryMark className="size-14" />
              <h2 className="mt-5 text-[28px] font-semibold tracking-[-0.025em] text-balance">{greeting(status?.displayName)}</h2>
              <p className="mt-1.5 text-[15px] text-muted-foreground">What should {assistant} pick up?</p>
            </div>
          ) : (
            <div className="space-y-8 pt-6 pb-10" aria-busy={loading || undefined}>
              {loading && (
                <div className="space-y-8" role="status" aria-label="Loading the conversation">
                  <Skeleton className="ml-auto h-10 w-1/2 rounded-3xl" />
                  <div className="space-y-2"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-11/12" /><Skeleton className="h-4 w-2/3" /></div>
                </div>
              )}
              {missing && (
                <Alert>
                  <AlertTitle>This chat isn&apos;t here</AlertTitle>
                  <AlertDescription>It may have been deleted. Start a new one, or pick another from the sidebar.</AlertDescription>
                  <AlertAction><Button size="sm" render={<Link href="/chat" />}>New chat</Button></AlertAction>
                </Alert>
              )}
              {messageStatus === "CanLoadMore" && (
                <div className="flex justify-center">
                  <Button variant="outline" size="sm" onClick={() => { if (scroller.current) olderScroll.current = { height: scroller.current.scrollHeight, top: scroller.current.scrollTop }; loadMore(50); }}>
                    Load earlier messages
                  </Button>
                </div>
              )}
              {messageStatus === "LoadingMore" && <p className="text-center text-sm text-muted-foreground" role="status">Loading earlier messages…</p>}
              {messages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  assistant={assistant}
                  latest={message.id === lastMessage?.id}
                  canEdit={!waiting}
                  canRegenerate={message.id === lastMessage?.id && !waiting}
                  busy={busy}
                  onEdit={(text) => void rewind(message.id, text)}
                  onRegenerate={() => void rewind(message.id)}
                  onBranch={() => void branch(message.id)}
                />
              ))}
              {shownPending.map((item, index) => <PendingRow key={index} text={item.text} attachments={item.attachments} sent={item.sent} />)}
              {waiting && !here.length && <ReplyInProgress streaming={chat?.streaming} />}
              {here.map((approval) => <ApprovalCard key={approval.id} approval={approval} now={now} showChat={false} />)}
              {chat?.lastError && !chat.isRunning && !waiting && (
                <Alert variant="destructive">
                  <TriangleAlertIcon />
                  <AlertTitle>{assistant} couldn&apos;t finish the last reply</AlertTitle>
                  <AlertDescription>
                    <p>{/runner|offline|computer/i.test(chat.lastError) ? "Your computer may be offline. Start Perry on it, then try again." : "Try again, or open Activity for the full run."}</p>
                    <p className="mt-1 font-mono text-xs opacity-80 [overflow-wrap:anywhere]">{chat.lastError.slice(0, 400)}</p>
                  </AlertDescription>
                  {lastUser && (
                    <AlertAction>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void rewind(lastUser.id)}><RefreshCwIcon />Try again</Button>
                    </AlertAction>
                  )}
                </Alert>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="relative shrink-0 px-3 pb-3 sm:px-6 sm:pb-5">
        {!atBottom && selectedId && (
          <div className="pointer-events-none absolute inset-x-0 -top-12 flex justify-center">
            <Button variant="outline" size="sm" className="pointer-events-auto rounded-full bg-background shadow-md" onClick={jumpToLatest}>
              <ArrowDownIcon />{waiting ? "New reply below" : "Jump to latest"}
            </Button>
          </div>
        )}
        <div className="mx-auto w-full max-w-3xl">
          <p className="sr-only" role="status" aria-live="polite">{waiting ? `${assistant} is replying` : ""}</p>
          <Composer
            ref={composer}
            assistant={assistant}
            draft={draft}
            onDraftChange={setDraft}
            onSubmit={() => void submit()}
            onStop={selectedId ? stop : undefined}
            waiting={waiting}
            busy={busy}
            uploading={uploading}
            files={files}
            onAddFiles={addFiles}
            onRemoveFile={(file) => setFiles((items) => items.filter((item) => item !== file))}
            suggestions={suggestions}
            completing={completing}
            pickers={{
              models, model, onModel: applyModel, modelInfo, effort, onEffort: applyEffort, access, onAccess: applyAccess,
              accessDisabled: selectedId ? chat === undefined : defaultAccess === undefined,
            }}
            above={<>
              {error && <ComposerNote tone="error" onDismiss={() => setError("")}>{error}</ComposerNote>}
              {notice && <ComposerNote tone="info" onDismiss={() => setNotice("")}>{notice}</ComposerNote>}
              {!selectedId && !draft && files.length === 0 && (
                <div className="mb-3 flex flex-wrap justify-center gap-2">
                  {STARTERS.map((text) => (
                    <Button key={text} variant="outline" className="h-9 rounded-full px-4 font-normal text-muted-foreground hover:text-foreground" onClick={() => { setDraft(text); composer.current?.focus(); }}>
                      {text}
                    </Button>
                  ))}
                </div>
              )}
            </>}
          />
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {access === "full"
              ? <span className="text-warning">Full access: {assistant} acts on this computer without asking. Every command still shows in Activity.</span>
              : <>Type <kbd className="font-mono">/</kbd> for commands. Drop or paste files to attach them.</>}
          </p>
        </div>
      </div>

      {summary && <RenameDialog chat={renaming ? summary : null} onClose={() => setRenaming(false)} />}
      {summary && <DeleteDialog chat={removing ? summary : null} onClose={() => setRemoving(false)} />}
    </div>
  );
}

function ChatMenu({ pinned, onPin, onRename, onCopyId, activityHref, onDelete }: {
  pinned: boolean; onPin: () => void; onRename: () => void; onCopyId: () => void; activityHref: string; onDelete: () => void;
}) {
  const router = useRouter();
  return (
    <>
      <Button variant="ghost" size="icon-sm" className="text-muted-foreground md:hidden" aria-label="New chat" render={<Link href="/chat" />}>
        <SquarePenIcon />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Chat options" />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem onClick={onPin}>{pinned ? <PinOffIcon /> : <PinIcon />}{pinned ? "Unpin" : "Pin"}</DropdownMenuItem>
          <DropdownMenuItem onClick={onRename}><PencilIcon />Rename</DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push(activityHref)}><ActivityIcon />View activity</DropdownMenuItem>
          <DropdownMenuItem onClick={onCopyId}><CopyIcon />Copy session ID</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}><Trash2Icon />Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
