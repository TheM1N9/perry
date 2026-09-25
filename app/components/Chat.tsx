"use client";

import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { api } from "@/convex/_generated/api";
import {
  ACCESS_LABELS, COMPACTED, chatModel, describeAccess, describeEfforts, describeModels, effortUnused, findModel, parseAccessCommand,
  parseModelCommand, parseThinkCommand, pickAccess, pickEffort, pickModel, type Access,
} from "@/convex/lib/commands";
import { Approvals } from "./Approvals";
import type { ChatId } from "./ChatList";
import { Sidebar, type NavigationState, type SectionId } from "./Sidebar";
import { CopyButton, Icon, Kbd, Notice, Spinner, errorText, fullDate, useCopy, useToast } from "./ui";
import type { Id } from "@/convex/_generated/dataModel";


const quickStarts = [
  { text: "Help me plan my day", hint: "Uses your calendar and tasks when they're connected" },
  { text: "Summarize what we worked on recently", hint: "Draws on earlier chats and saved memory" },
  { text: "I have an idea to think through", hint: "Talk it out, then save what matters" },
];

const MAX_FILES = 10;
const MAX_BYTES = 50 * 1024 * 1024;
const ACCEPT = "image/*,video/*,audio/*,.pdf,.txt,.md,.csv,.json";

type Attachment = { url: string; fileName: string; contentType: string };
type PendingAttachment = Attachment & { id: Id<"chatAttachments"> };
/** A message you sent that the history does not show yet: the one that started a reply, or one sent into it. */
type Pending = { id: ChatId; text: string; attachments: Attachment[]; baselineCount: number; seenRunning: boolean };

/** How the composer names a thinking level; Codex's own ids otherwise, capitalised. */
const levelName = (level: string) => level === "xhigh" ? "Extra high" : `${level[0]?.toUpperCase() ?? ""}${level.slice(1)}`;
const ACCESS_HINTS: Record<Access, string> = {
  supervised: "Codex works in its sandbox, and asks you before anything beyond it",
  full: "No sandbox: Codex acts on this computer without asking",
};

const bytes = (size: number) => size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const timeOf = (timestamp: number) => new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  if (!attachments.length) return null;
  return <div className="chat-attachments">{attachments.map((attachment) => {
    if (attachment.contentType.startsWith("image/")) return <a key={attachment.url} href={attachment.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${attachment.fileName}`}><img src={attachment.url} alt={attachment.fileName} loading="lazy" /></a>;
    if (attachment.contentType.startsWith("video/")) return <video key={attachment.url} controls preload="metadata" src={attachment.url} aria-label={attachment.fileName} />;
    if (attachment.contentType.startsWith("audio/")) return <audio key={attachment.url} controls src={attachment.url} aria-label={attachment.fileName} />;
    return <a className="chat-attachment-file" key={attachment.url} href={attachment.url} target="_blank" rel="noopener noreferrer"><Icon name="paperclip" size={14} />{attachment.fileName}</a>;
  })}</div>;
}

/** The text of a React node tree, for copying a code block. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

/**
 * Assistant replies are GitHub-flavoured Markdown, with single line breaks kept
 * as a chat reader expects. Raw HTML in a reply stays text, since replies can
 * quote web pages and email, and links open in a new tab.
 */
function Markdown({ text }: { text: string }) {
  return <div className="chat-markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{
      a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
      pre: ({ node: _node, children, ...props }) => <div className="code-block"><pre {...props}>{children}</pre><CopyButton value={textOf(children).replace(/\n$/, "")} iconOnly label="Copy code" /></div>,
      table: ({ node: _node, ...props }) => <div className="table-wrap"><table {...props} /></div>,
    }}>{text}</ReactMarkdown>
  </div>;
}

export function Chat({ dashboardKey, onNavigate, onLock }: {
  dashboardKey: string;
  onNavigate: (section: SectionId) => void;
  onLock: () => void;
}) {
  const toast = useToast();
  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  const skipOnboarding = useMutation(api.dashboard.skipOnboarding);
  const redoOnboarding = useMutation(api.dashboard.redoOnboarding);
  /** What the owner named the assistant on the welcome page. */
  const assistant = status?.assistantName ?? "Perry";
  const chats = useQuery(api.dashboard.listChats, { key: dashboardKey });
  const createChat = useMutation(api.dashboard.createChat);
  const branchChat = useAction(api.dashboard.branchChat);
  const rewindChat = useAction(api.dashboard.rewindChat);
  const sendChat = useMutation(api.dashboard.sendChat);
  const stopChat = useMutation(api.dashboard.stopChat);
  const resetChat = useAction(api.dashboard.resetChat);
  const compactChat = useMutation(api.dashboard.compactChat);
  const generateUploadUrl = useMutation(api.dashboard.generateUploadUrl);
  const registerAttachment = useMutation(api.dashboard.registerAttachment);
  const modelOptions = useQuery(api.models.options, { key: dashboardKey });
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
  const defaultAccess = useQuery(api.dashboard.getDefaultAccess, { key: dashboardKey });
  /** The model picked for a chat that has not been sent yet. */
  const [draftModel, setDraftModel] = useState<string | undefined>(undefined);
  /** Its thinking level and access; unset is the model's default level and the default access. */
  const [draftEffort, setDraftEffort] = useState<string | undefined>(undefined);
  const [draftAccess, setDraftAccess] = useState<Access | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<ChatId | null>(null);
  const [restored, setRestored] = useState(false);
  const [draft, setDraft] = useState("");
  /** A command's answer, shown above the composer instead of being sent as a message. */
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  /** The /compact being waited on, to say when it is done. */
  const [compaction, setCompaction] = useState<Id<"codexTurns"> | null>(null);
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [pickedPreviews, setPickedPreviews] = useState<Map<File, string>>(new Map());
  /** Which upload is in flight, to say so while files are sent. */
  const [uploading, setUploading] = useState<{ index: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** The message you are editing, if any. */
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  /** The highlighted slash-command suggestion. */
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  /** Whether the arrow keys moved through the suggestions since the draft last changed. */
  const [suggestionPicked, setSuggestionPicked] = useState(false);
  /** Whether the reader is at the newest message; only then does new content scroll into view. */
  const [atBottom, setAtBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const olderScroll = useRef<{ height: number; top: number } | null>(null);
  const stickToBottom = useRef(true);
  const draftingNew = useRef(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const chat = useQuery(api.dashboard.getChat, selectedId ? { key: dashboardKey, id: selectedId } : "skip");
  const { results: newestMessages, status: messageStatus, loadMore } = usePaginatedQuery(
    api.dashboard.getChatMessages,
    selectedId ? { key: dashboardKey, id: selectedId } : "skip",
    { initialNumItems: 50 },
  );
  const messages = useMemo(() => [...newestMessages].sort((a, b) => a.createdAt - b.createdAt), [newestMessages]);
  const compactionStatus = useQuery(api.dashboard.getCompaction, compaction ? { key: dashboardKey, id: compaction } : "skip");

  const fromUrl = () => {
    const match = window.location.pathname.match(/^\/chat\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) as ChatId : null;
  };
  useEffect(() => {
    // "New chat" from another page arrives on /chat with this on the history entry.
    draftingNew.current = !fromUrl() && (window.history.state as NavigationState | null)?.newChat === true;
    setSelectedId(fromUrl() ?? window.localStorage.getItem("perry.activeChat") as ChatId | null);
    setRestored(true);
    // Back and forward move between chats.
    const onPop = () => { if (window.location.pathname.startsWith("/chat")) { draftingNew.current = !fromUrl(); setSelectedId(fromUrl()); } };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (!restored) return;
    const path = selectedId ? `/chat/${encodeURIComponent(selectedId)}` : "/chat";
    if (selectedId) window.localStorage.setItem("perry.activeChat", selectedId);
    else window.localStorage.removeItem("perry.activeChat");
    if (window.location.pathname === path) return;
    // Picking a chat is a step back can undo; settling on one after load is not.
    if (/^\/chat\/[^/]+/.test(window.location.pathname)) window.history.pushState(null, "", path);
    else window.history.replaceState(null, "", path);
  }, [restored, selectedId]);
  useEffect(() => { if (selectedId) draftingNew.current = false; }, [selectedId]);
  useEffect(() => {
    if (!chats || !restored || draftingNew.current) return;
    if (selectedId && chats.some((item) => item.id === selectedId)) return;
    setSelectedId(chats[0]?.id ?? null);
  }, [chats, restored]);
  useEffect(() => {
    const title = chats?.find((item) => item.id === selectedId)?.title;
    document.title = title ? `${title} · Perry` : "Perry";
  }, [chats, selectedId]);
  // A sent message stops being pending once the history has it, or once the
  // reply it started or joined has come and gone.
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
  useEffect(() => {
    const previews = new Map(pickedFiles.map((file) => [file, URL.createObjectURL(file)]));
    setPickedPreviews(previews);
    return () => previews.forEach((url) => URL.revokeObjectURL(url));
  }, [pickedFiles]);

  // A new chat opens at its newest message; after that, new content only
  // scrolls into view for a reader who is already at the bottom.
  useLayoutEffect(() => { stickToBottom.current = true; setAtBottom(true); }, [selectedId]);
  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    stickToBottom.current = bottom;
    setAtBottom(bottom);
  }, []);

  const shownPending = pending.filter((item) => item.id === selectedId);
  const waiting = shownPending.length > 0 || Boolean(chat?.isRunning);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (olderScroll.current) {
      element.scrollTop = olderScroll.current.top + element.scrollHeight - olderScroll.current.height;
      olderScroll.current = null;
    } else if (stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [selectedId, messages.length, shownPending.length, waiting, chat?.streaming]);
  const jumpToLatest = () => {
    stickToBottom.current = true;
    setAtBottom(true);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  const active = chats?.find((item) => item.id === selectedId);
  const parent = chats?.find((item) => item.id === active?.parentConversationId);
  const codexModels = modelOptions?.codex ?? [];
  const model = (selectedId ? chat?.model : draftModel)
    ?? (codexModels.find((item) => item.isDefault) ?? codexModels[0])?.id;
  // The thinking levels are the model's own; a level it does not take is kept but unused.
  const modelInfo = chatModel(codexModels, model);
  const efforts = modelInfo?.efforts ?? [];
  const pickedEffort = selectedId ? chat?.effort : draftEffort;
  const effortIsUnused = Boolean(modelInfo && effortUnused(modelInfo, pickedEffort));
  const effort = effortIsUnused ? undefined : pickedEffort;
  const access: Access = (selectedId ? chat?.access : draftAccess) ?? defaultAccess ?? "supervised";
  function applyModel(next: string) {
    const picked = codexModels.find((item) => item.id === next);
    if (picked && pickedEffort && effortUnused(picked, pickedEffort)) {
      setNotice(`${picked.name} does not take the ${pickedEffort} thinking level, so it thinks at its default here.`);
    }
    if (!selectedId) { setDraftModel(next || undefined); return; }
    void setChatModel({ key: dashboardKey, id: selectedId, model: next || undefined }).catch((cause) => setError(errorText(cause)));
  }
  function applyEffort(next: string | undefined) {
    if (!selectedId) { setDraftEffort(next); return; }
    void setChatEffort({ key: dashboardKey, id: selectedId, effort: next }).catch((cause) => setError(errorText(cause)));
  }
  function applyAccess(next: Access) {
    if (!selectedId) { setDraftAccess(next); return; }
    void setChatAccess({ key: dashboardKey, id: selectedId, access: next }).catch((cause) => setError(errorText(cause)));
  }

  function select(id: ChatId | null) {
    draftingNew.current = id === null;
    setSelectedId(id);
    setSidebarOpen(false);
    setEditing(null);
    setError("");
  }

  function startNewChat() {
    select(null);
    setDraft("");
    window.setTimeout(() => composer.current?.focus(), 0);
  }

  async function makeChat() {
    setError(""); setBusy(true);
    try {
      const id = await createChat({ key: dashboardKey });
      draftingNew.current = false;
      setSelectedId(id); setSidebarOpen(false); setDraft("");
      window.setTimeout(() => composer.current?.focus(), 0);
      return id;
    } catch (cause) { setError(errorText(cause)); return null; }
    finally { setBusy(false); }
  }
  /** Keep the file on this machine through the local media server, or in Convex storage when that is turned off. */
  async function store(file: File): Promise<{ localPath: string } | { storageId: Id<"_storage"> }> {
    const local = await fetch("/api/media", { method: "POST", headers: { "x-file-name": encodeURIComponent(file.name) }, body: file });
    if (local.ok) return { localPath: (await local.json() as { path: string }).path };
    if (local.status !== 501) throw new Error((await local.json().catch(() => null) as { error?: string } | null)?.error ?? `Could not save ${file.name}.`);
    const uploadUrl = await generateUploadUrl({ key: dashboardKey });
    const response = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
    if (!response.ok) throw new Error(`Could not upload ${file.name}.`);
    const body = await response.json() as { storageId?: Id<"_storage"> };
    if (!body.storageId) throw new Error(`Could not store ${file.name}.`);
    return { storageId: body.storageId };
  }
  /** Add files from the picker, a paste or a drop, turning away what cannot be sent. */
  function addFiles(files: File[]) {
    if (!files.length) return;
    const tooBig = files.filter((file) => file.size > MAX_BYTES);
    const empty = files.filter((file) => file.size === 0);
    const usable = files.filter((file) => file.size > 0 && file.size <= MAX_BYTES);
    const room = Math.max(0, MAX_FILES - pickedFiles.length);
    const left = usable.length - room;
    const problems = [
      tooBig.length ? `${tooBig.map((file) => file.name).join(", ")} ${tooBig.length === 1 ? "is" : "are"} over 50 MB.` : "",
      empty.length ? `${empty.map((file) => file.name).join(", ")} ${empty.length === 1 ? "is" : "are"} empty.` : "",
      left > 0 ? `Only ${MAX_FILES} files fit in one message, so ${left} ${left === 1 ? "was" : "were"} left out.` : "",
    ].filter(Boolean);
    if (problems.length) setError(problems.join(" "));
    setPickedFiles((items) => [...items, ...usable].slice(0, MAX_FILES));
  }

  const COMMANDS = [
    { command: "/model", hint: "List the Codex models, or /model <name> to switch this chat" },
    { command: "/set model", hint: "Switch this chat's model: /set model <name>" },
    { command: "/think", hint: "List the thinking levels, or /think <level> to set this chat's" },
    { command: "/access", hint: "Supervised or Full access: whether Codex asks before acting" },
    { command: "/stop", hint: "Stop the reply being written" },
    { command: "/compact", hint: "Shrink what Codex carries of this chat; the messages stay" },
    { command: "/reset", hint: "Save this chat to memory, then start it afresh" },
  ];
  const typedCommand = parseModelCommand(draft);
  const typedThink = parseThinkCommand(draft);
  const typedAccess = parseAccessCommand(draft);
  // Past a command's name, the suggestions are its choices.
  const choosing = /^\/(?:(?:set\s+)?model|think|access)\s/i.test(draft);
  type Suggestion = { key: string; label: string; hint: string; apply: () => void };
  const choices = (options: Array<{ value: string; label: string; hint: string }>, typed: string | undefined, command: string): Suggestion[] =>
    options.filter((option) => !typed || option.value.startsWith(typed)).map((option) => ({
      key: option.value, label: option.label, hint: option.hint, apply: () => void runCommand(`${command} ${option.value}`),
    }));
  const suggestions: Suggestion[] = !draft.startsWith("/") || suggestionsDismissed
    ? []
    : typedCommand && choosing
      ? (typedCommand.name ? findModel(codexModels, typedCommand.name).matches : codexModels).map((item) => ({
          key: item.id,
          label: item.name,
          hint: `${item.id}${item.id === model ? " · current" : ""}${item.isDefault ? " · default" : ""}`,
          apply: () => void runCommand(`/model ${item.id}`),
        }))
      : typedThink && choosing
        ? choices([
            { value: "default", label: "Default", hint: `${modelInfo?.defaultEffort ?? "the model's own"}${effort ? "" : " · current"}` },
            ...efforts.map((level) => ({ value: level, label: levelName(level), hint: `${level}${level === effort ? " · current" : ""}` })),
          ], typedThink.level, "/think")
        : typedAccess && choosing
          ? choices((["supervised", "full"] as const).map((mode) => ({ value: mode, label: ACCESS_LABELS[mode], hint: `${ACCESS_HINTS[mode]}${mode === access ? " · current" : ""}` })), typedAccess.mode, "/access")
          : COMMANDS.filter((item) => item.command.startsWith(draft.trim().toLowerCase()) && draft.trim().length <= item.command.length).map((item) => ({
              key: item.command,
              label: item.command,
              hint: item.hint,
              apply: () => { setDraft(item.command === "/stop" || item.command === "/compact" || item.command === "/reset" ? item.command : `${item.command} `); composer.current?.focus(); },
            }));
  const highlighted = Math.min(suggestionIndex, Math.max(0, suggestions.length - 1));
  const completingCommand = draft.startsWith("/") && !choosing;
  /** A half-typed level or access ("/think hi"), which Enter completes. */
  const completingChoice = choosing && !typedCommand && suggestions.length > 0
    && !suggestions.some((item) => item.key === (typedThink?.level ?? typedAccess?.mode));
  useEffect(() => { setSuggestionIndex(0); setSuggestionPicked(false); }, [draft]);
  useEffect(() => { if (!draft.startsWith("/")) setSuggestionsDismissed(false); }, [draft]);

  /** Commands never become messages: they change this chat, then say what they did. */
  async function runCommand(text: string): Promise<boolean> {
    const trimmed = text.trim();
    const modelCommand = parseModelCommand(trimmed);
    if (modelCommand) {
      if (!modelCommand.name) { setDraft(""); setNotice(describeModels(codexModels, model)); return true; }
      const picked = pickModel(codexModels, modelCommand.name, pickedEffort);
      // A name that matched nothing, or several models, stays in the box to be fixed.
      if (picked.model) { applyModel(picked.model.id); setDraft(""); }
      setNotice(picked.reply);
      return true;
    }
    const thinkCommand = parseThinkCommand(trimmed);
    if (thinkCommand) {
      if (!thinkCommand.level) { setDraft(""); setNotice(describeEfforts(codexModels, model, pickedEffort)); return true; }
      const picked = pickEffort(codexModels, model, thinkCommand.level);
      // A level the model does not take stays in the box to be fixed.
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
    if (trimmed.toLowerCase() === "/stop") {
      setDraft("");
      if (selectedId && waiting) await stopChat({ key: dashboardKey, id: selectedId });
      setNotice(selectedId && waiting ? "Stopping." : "Nothing is running.");
      return true;
    }
    if (trimmed.toLowerCase() === "/reset") {
      setDraft("");
      if (!selectedId) { setNotice("Nothing to reset yet."); return true; }
      setNotice("Saving this chat to memory and starting it afresh…");
      try { setNotice(await resetChat({ key: dashboardKey, id: selectedId })); }
      catch (cause) { setNotice(""); setError(errorText(cause)); }
      return true;
    }
    if (trimmed.toLowerCase() === "/compact") {
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
    if (message.startsWith("/") && pickedFiles.length === 0 && await runCommand(message)) return;
    // Sent while a reply is running, the message joins that reply (it steers it).
    if ((!message && pickedFiles.length === 0) || busy || uploading) return;
    const fresh = !selectedId;
    const id = selectedId ?? await makeChat();
    if (!id) return;
    const files = pickedFiles;
    const messageKey = files.length ? crypto.randomUUID() : undefined;
    setDraft(""); setPickedFiles([]); setError("");
    stickToBottom.current = true;
    let sent: Pending | undefined;
    try {
      const uploaded: PendingAttachment[] = [];
      for (const [index, file] of files.entries()) {
        setUploading({ index: index + 1, total: files.length });
        const attachmentId = await registerAttachment({ key: dashboardKey, conversationId: id, messageKey: messageKey!, ...await store(file), fileName: file.name, contentType: file.type || "application/octet-stream", size: file.size });
        uploaded.push({ id: attachmentId, url: URL.createObjectURL(file), fileName: file.name, contentType: file.type || "application/octet-stream" });
      }
      setUploading(null);
      const entry: Pending = { id, text: message, attachments: uploaded, baselineCount: selectedId === id ? messages.filter((item) => item.role === "user" && item.text === message).length : 0, seenRunning: selectedId === id && Boolean(chat?.isRunning) };
      sent = entry;
      setPending((items) => [...items, entry]);
      // A new chat takes what was picked before it existed; an existing one already has its own.
      await sendChat({
        key: dashboardKey, id, text: message, attachmentIds: uploaded.map((item) => item.id), messageKey, model,
        ...(fresh ? { effort: draftEffort ?? "", access: draftAccess } : {}),
      });
      // Full access is chosen for a chat, never carried into the next new one.
      if (fresh) setDraftAccess(undefined);
    } catch (cause) {
      setUploading(null);
      setPending((items) => items.filter((item) => item !== sent));
      setDraft(message); setPickedFiles(files);
      setError(`Your message wasn't sent: ${errorText(cause)}`);
    }
  }
  /** Regenerate from an assistant reply, or resend one of your messages with new text. */
  async function rewind(messageId: string, text?: string) {
    if (!selectedId || busy || waiting) return;
    const index = messages.findIndex((message) => message.id === messageId);
    const sent = [...messages.slice(0, index + 1)].reverse().find((message) => message.role === "user");
    const shown = text ?? sent?.text ?? "";
    setBusy(true); setError(""); setEditing(null);
    stickToBottom.current = true;
    // The old copy of the message counts until it is removed, so it is part of the baseline.
    const entry: Pending = { id: selectedId, text: shown, attachments: sent?.attachments ?? [], baselineCount: messages.filter((message) => message.role === "user" && message.text === shown).length, seenRunning: false };
    try {
      setPending((items) => [...items, entry]);
      await rewindChat({ key: dashboardKey, id: selectedId, messageId, text });
    } catch (cause) { setPending((items) => items.filter((item) => item !== entry)); setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  async function branch(messageId: string) {
    if (!selectedId || busy) return;
    setBusy(true); setError("");
    try {
      const id = await branchChat({ key: dashboardKey, id: selectedId, messageId });
      draftingNew.current = false;
      setSelectedId(id); setSidebarOpen(false); window.setTimeout(() => composer.current?.focus(), 0);
      toast({ tone: "success", text: "Branched into a new chat." });
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const lastUser = [...messages].reverse().find((message) => message.role === "user");

  return <div className="app chat-workspace">
    <a className="skip-link" href="#composer">Skip to message box</a>
    <Sidebar dashboardKey={dashboardKey} current="chat" onNavigate={onNavigate} onLock={onLock} open={sidebarOpen} onClose={closeSidebar}
      selectedChat={selectedId} onSelectChat={select} onNewChat={startNewChat} />
    <main className="main chat-main" inert={sidebarOpen || undefined}>
      <header className="topbar chat-header">
        <div className="topbar-left">
          <button type="button" className="icon-button mobile-menu chat-mobile-menu" aria-label="Open navigation" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button>
          <div className="chat-header-title">
            <strong>{active?.title ?? (selectedId && chats === undefined ? " " : "New chat")}</strong>
            {selectedId && <div className="chat-header-meta">
              <CopySessionId id={selectedId} />
              {active?.parentConversationId && <button type="button" className="chat-parent-link" disabled={!parent} onClick={() => { if (parent) select(parent.id); }}><Icon name="branch" size={12} />Branched from {parent?.title ?? "a deleted chat"}</button>}
            </div>}
          </div>
        </div>
        <div className="topbar-right">
          <button type="button" className="icon-button chat-header-new" title="New chat" aria-label="New chat" onClick={startNewChat} disabled={busy}><Icon name="plus" /></button>
        </div>
      </header>
        {/* An install from before the welcome page: offered once, never forced, and kept in view above the messages. */}
        {status?.onboarding === "offer" && <div className="chat-offer">
          <Notice tone="info" title={`Tell ${assistant} about yourself`} onDismiss={() => void skipOnboarding({ key: dashboardKey }).catch((cause) => toast({ tone: "danger", text: errorText(cause) }))}
            action={<>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void redoOnboarding({ key: dashboardKey }).then(() => onNavigate("welcome"), (cause) => toast({ tone: "danger", text: errorText(cause) }))}>Get started</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void skipOnboarding({ key: dashboardKey }).catch((cause) => toast({ tone: "danger", text: errorText(cause) }))}>Not now</button>
            </>}>
            A few questions, a name and a personality, and a USER.md {assistant} reads before every reply. It takes about two minutes, and you can edit everything later.
          </Notice>
        </div>}
      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        {!selectedId ? <div className="chat-welcome">
          <h1>What can {assistant} help with?</h1>
          <p>Ask a question, plan something, or pick up an earlier thread. {assistant} remembers what you ask it to, across every chat.</p>
          <div className="chat-prompts">{quickStarts.map((prompt) => <button type="button" key={prompt.text} onClick={() => { setDraft(prompt.text); composer.current?.focus(); }}>
            <span>{prompt.text}<small>{prompt.hint}</small></span><Icon name="chevron" size={14} />
          </button>)}</div>
        </div> :
          <div className="chat-thread" aria-busy={messageStatus === "LoadingFirstPage"}>
            {(chat === undefined || messageStatus === "LoadingFirstPage") && <div className="chat-thread-loading" role="status"><Spinner /> Loading conversation…</div>}
            {chat === null && <Notice tone="warning" title="This chat isn't available">It may have been deleted. Pick another chat or start a new one.</Notice>}
            {messageStatus === "CanLoadMore" && <div className="chat-load-older"><button type="button" className="btn btn-secondary btn-sm" onClick={() => { if (scroller.current) olderScroll.current = { height: scroller.current.scrollHeight, top: scroller.current.scrollTop }; loadMore(50); }}>Load earlier messages</button></div>}
            {messageStatus === "LoadingMore" && <div className="chat-thread-loading" role="status"><Spinner /> Loading earlier messages…</div>}
            {chat && messageStatus !== "LoadingFirstPage" && messages.length === 0 && shownPending.length === 0 && <div className="chat-thread-empty"><h2>Start the conversation</h2><p>Messages here stay together. Saved memories are available in every chat.</p></div>}
            {messages.map((message) => <div key={message.id} className={`chat-turn ${message.role === "user" ? "from-user" : "from-assistant"}`}>
              {message.role !== "user" && <div className="chat-avatar" aria-hidden="true">{assistant.charAt(0).toUpperCase()}</div>}
              <div className="chat-turn-body">
                <span className="sr-only">{message.role === "user" ? "You said" : `${assistant} said`}</span>
                {editing?.id === message.id
                  ? <form className="chat-edit" onSubmit={(event) => { event.preventDefault(); if (editing.text.trim()) void rewind(message.id, editing.text); }}>
                      <textarea autoFocus aria-label="Edit your message" value={editing.text} onChange={(event) => setEditing({ id: message.id, text: event.target.value })}
                        onKeyDown={(event) => { if (event.key === "Escape") setEditing(null); if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
                      <div className="chat-edit-actions"><button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="btn btn-primary btn-sm chat-edit-save" disabled={!editing.text.trim() || busy}>Save and resend</button></div>
                    </form>
                  : <div className="chat-bubble">{message.role === "user" ? message.text : <Markdown text={message.text} />}<AttachmentList attachments={message.attachments ?? []} /></div>}
                {message.fallback && <div className="chat-fallback-note"><Icon name="computer" size={13} />Answered without your computer</div>}
                {editing?.id !== message.id && <div className="chat-turn-foot">
                  {message.role === "user" && <time className="chat-turn-time" dateTime={new Date(message.createdAt).toISOString()} title={fullDate(message.createdAt)}>{timeOf(message.createdAt)}</time>}
                  <div className="chat-turn-actions">
                    <CopyMessage text={message.text} />
                    {message.role === "user" && !waiting && <button type="button" title="Edit and resend this message" onClick={() => setEditing({ id: message.id, text: message.text })} disabled={busy}><Icon name="pencil" size={13} />Edit</button>}
                    {message.role !== "user" && message.id === messages.at(-1)?.id && !waiting && <button type="button" title="Write this reply again" onClick={() => void rewind(message.id)} disabled={busy}><Icon name="redo" size={13} />Regenerate</button>}
                    <button type="button" title="Branch from this message into a new chat" onClick={() => void branch(message.id)} disabled={busy}><Icon name="branch" size={13} />Branch</button>
                  </div>
                  {message.role !== "user" && <time className="chat-turn-time" dateTime={new Date(message.createdAt).toISOString()} title={fullDate(message.createdAt)}>{timeOf(message.createdAt)}</time>}
                </div>}
              </div>
            </div>)}
            {shownPending.map((item, index) => <div key={index} className="chat-turn from-user pending"><div className="chat-turn-body"><div className="chat-bubble">{item.text}<AttachmentList attachments={item.attachments} /></div><div className="chat-turn-foot"><span className="chat-turn-time" style={{ opacity: 1 }}>Sending…</span></div></div></div>)}
            {waiting && <div className="chat-turn from-assistant pending" aria-live="polite" aria-busy="true"><div className="chat-avatar" aria-hidden="true">{assistant.charAt(0).toUpperCase()}</div>{chat?.streaming
              ? <div className="chat-turn-body"><div className="chat-bubble chat-streaming"><Markdown text={chat.streaming} /></div>{chat.fallback && <div className="chat-fallback-note"><Icon name="computer" size={13} />Answering without your computer</div>}</div>
              : <div className="chat-thinking" role="status" aria-label={`${assistant} is thinking`}><i /><i /><i /></div>}</div>}
            {chat?.lastError && !chat.isRunning && <div className="chat-turn-error"><Notice tone="danger" title={`${assistant} couldn't finish the last reply`} details={chat.lastError}
              action={lastUser && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void rewind(lastUser.id)}><Icon name="redo" size={13} />Try again</button>}>
              {/runner|offline|computer/i.test(chat.lastError) ? "Your computer may be offline. Start the runner, then try again." : "Try again, or open Activity for the full run."}
            </Notice></div>}
          </div>}
        {!atBottom && selectedId && <div className="chat-jump"><button type="button" className="btn btn-secondary btn-sm" onClick={jumpToLatest}><Icon name="arrowDown" size={13} />{waiting ? "New reply below" : "Jump to latest"}</button></div>}
      </div>
      <div className="chat-composer-area"><div className="chat-composer-wrap">
        <Approvals dashboardKey={dashboardKey} />
        {error && <div className="chat-error" role="alert"><span>{error}</span><button type="button" className="icon-button sm" aria-label="Dismiss error" onClick={() => setError("")}><Icon name="close" size={14} /></button></div>}
        {notice && <div className="chat-notice" role="status"><pre>{notice}</pre><button type="button" className="icon-button sm" aria-label="Dismiss" onClick={() => setNotice("")}><Icon name="close" size={14} /></button></div>}
        {suggestions.length > 0 && <div className="chat-commands" role="listbox" id="chat-commands" aria-label="Commands">{suggestions.map((item, index) => <button type="button" key={item.key} id={`chat-command-${index}`} role="option" aria-selected={index === highlighted} tabIndex={-1}
          onMouseMove={() => setSuggestionIndex(index)} onMouseDown={(event) => { event.preventDefault(); item.apply(); }}><span>{item.label}</span><small>{item.hint}</small></button>)}</div>}
        <div className="chat-composer-box" onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); } }}>
          {pickedFiles.length > 0 && <div className="chat-picked-files">{pickedFiles.map((file, index) => {
            const url = pickedPreviews.get(file);
            const preview = url && file.type.startsWith("image/") ? <img src={url} alt={file.name} />
              : url && file.type.startsWith("video/") ? <video src={url} muted playsInline preload="metadata" aria-label={file.name} />
              : <span className="chat-picked-name"><span><Icon name="paperclip" size={12} /> {file.name}</span><small>{bytes(file.size)}</small></span>;
            return <div className="chat-picked-file" key={`${index}-${file.name}-${file.lastModified}`} title={`${file.name} · ${bytes(file.size)}`}>{preview}<button type="button" aria-label={`Remove ${file.name}`} disabled={Boolean(uploading)} onClick={() => setPickedFiles((items) => items.filter((item) => item !== file))}><Icon name="close" size={11} /></button></div>;
          })}</div>}
          <textarea ref={composer} id="composer" value={draft} rows={1} aria-label={`Message ${assistant}`} placeholder={waiting ? "Add to the reply, or stop it…" : `Message ${assistant}…`}
            role="combobox" aria-expanded={suggestions.length > 0} aria-controls={suggestions.length ? "chat-commands" : undefined} aria-autocomplete="list" aria-activedescendant={suggestions.length ? `chat-command-${highlighted}` : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event) => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); addFiles(files); } }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (suggestions.length) {
                if (event.key === "ArrowDown") { event.preventDefault(); setSuggestionPicked(true); setSuggestionIndex((highlighted + 1) % suggestions.length); return; }
                if (event.key === "ArrowUp") { event.preventDefault(); setSuggestionPicked(true); setSuggestionIndex((highlighted - 1 + suggestions.length) % suggestions.length); return; }
                if (event.key === "Tab") { event.preventDefault(); suggestions[highlighted].apply(); return; }
                if (event.key === "Escape") { event.preventDefault(); setSuggestionsDismissed(true); return; }
                // Enter takes a suggestion you arrowed to, or finishes a half-typed command
                // name; anything already typed out in full runs as typed.
                if (event.key === "Enter" && !event.shiftKey && (suggestionPicked || completingChoice || (completingCommand && suggestions[highlighted].label.trim() !== draft.trim()))) { event.preventDefault(); suggestions[highlighted].apply(); return; }
              }
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
            }} />
          <div className="chat-composer-foot">
            <button type="button" className="chat-attach" aria-label="Attach files" title="Attach images, video, audio, or documents (up to 10, 50 MB each)" onClick={() => filePicker.current?.click()} disabled={busy || Boolean(uploading) || pickedFiles.length >= MAX_FILES}><Icon name="paperclip" size={16} /></button>
            <input ref={filePicker} type="file" multiple hidden accept={ACCEPT} onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
            <div className="chat-composer-controls">
              <select className="chat-picker chat-model" aria-label="Codex model" title={`Codex model: ${model ?? "default"}`} value={model ?? ""} disabled={modelOptions === undefined} onChange={(event) => applyModel(event.target.value)}>
                {modelOptions === undefined
                  ? <option value="">Loading models…</option>
                  : codexModels.length
                    ? codexModels.map((item) => <option key={item.id} value={item.id}>{item.name}{item.isDefault ? " (default)" : ""}</option>)
                    : <option value="">Codex default</option>}
              </select>
              {/* Only the levels the chosen model takes; Default leaves it to the model. */}
              {efforts.length > 0 && <select className="chat-picker chat-effort" aria-label="Thinking level" value={effort ?? ""}
                title={`Thinking level: ${effort ?? `default (${modelInfo?.defaultEffort ?? "the model's own"})`}${effortIsUnused ? `. ${modelInfo?.name} does not take ${pickedEffort}, so it thinks at its default.` : ""}`}
                onChange={(event) => applyEffort(event.target.value || undefined)}>
                <option value="">Default{modelInfo?.defaultEffort ? ` (${levelName(modelInfo.defaultEffort)})` : ""}</option>
                {efforts.map((level) => <option key={level} value={level}>{levelName(level)}</option>)}
              </select>}
              <select className={`chat-picker chat-access${access === "full" ? " full" : ""}`} aria-label="Access" value={access}
                title={`${ACCESS_LABELS[access]}: ${ACCESS_HINTS[access]}. Applies from the next reply.`}
                disabled={selectedId ? chat === undefined : defaultAccess === undefined}
                onChange={(event) => applyAccess(event.target.value as Access)}>
                <option value="supervised">{ACCESS_LABELS.supervised}</option>
                <option value="full">{ACCESS_LABELS.full}</option>
              </select>
            </div>
            <span className="chat-composer-hint" aria-live="polite">{uploading ? <><Spinner size={11} /> Uploading {uploading.index} of {uploading.total}…</> : <><Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line</>}</span>
            {/* Adapted from vercel/eve (Apache-2.0): packages/eve/src/setup/scaffold/create/web-template.ts */}
            {/* While a reply runs, a draft is sent into it; with nothing typed, the button stops it. */}
            {waiting && selectedId && !draft.trim() && pickedFiles.length === 0
              ? <button type="button" className="chat-send chat-stop" aria-label="Stop the reply" title="Stop the reply" onClick={() => void stopChat({ key: dashboardKey, id: selectedId }).catch((cause) => setError(errorText(cause)))}><Icon name="stop" size={14} /></button>
              : <button type="button" className="chat-send" aria-label={waiting ? "Send into the reply" : "Send message"} title={waiting ? "Send into the reply" : "Send"} onClick={() => void submit()} disabled={(!draft.trim() && pickedFiles.length === 0) || busy || Boolean(uploading)}>{uploading ? <Spinner /> : <Icon name="arrow" size={16} />}</button>}
          </div>
        </div>
        {access === "full"
          ? <div className="chat-composer-caption chat-access-warning"><Icon name="alert" size={12} />Full access: {assistant} acts on this computer without asking. Every command still shows in Activity.</div>
          : <div className="chat-composer-caption">Type / for commands. Drop or paste files to attach them.</div>}
      </div></div>
    </main>
  </div>;
}

function CopySessionId({ id }: { id: string }) {
  const { copied, copy } = useCopy();
  return <button type="button" className="chat-session-id" title={`Copy session ID ${id}`} onClick={() => copy(id)}>
    {copied ? <><Icon name="check" size={11} />Copied</> : <>{id.slice(-8)}<Icon name="copy" size={11} /></>}
    <span className="sr-only" aria-live="polite">{copied ? "Session ID copied" : ""}</span>
  </button>;
}

function CopyMessage({ text }: { text: string }) {
  const { copied, copy } = useCopy();
  return <button type="button" title="Copy this message" onClick={() => copy(text)}>
    <Icon name={copied ? "check" : "copy"} size={13} />{copied ? "Copied" : "Copy"}
  </button>;
}
