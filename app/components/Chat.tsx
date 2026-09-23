"use client";

import { useAction, useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type ChatId = Id<"conversations">;
const paths = {
  plus: "M12 5v14M5 12h14",
  search: "m21 21-4.35-4.35M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
  chat: "M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-9.5A7.5 7.5 0 0 1 10.5 4h2A7.5 7.5 0 0 1 20 11.5Z",
  branch: "M7 4v9a5 5 0 0 0 5 5h5M7 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM19 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM7 13a5 5 0 0 0 5-5h5",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3",
  pencil: "m4 20 4.5-1 10.8-10.8-3.5-3.5L5 15.5 4 20ZM14.7 5.3l3.5 3.5",
  menu: "M4 7h16M4 12h16M4 17h16",
  arrow: "M12 19V5m-6 6 6-6 6 6",
  close: "M5 5l14 14M19 5 5 19",
  paperclip: "m21.4 11.6-8.8 8.8a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 1 1-2.8-2.8l8.5-8.5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  spark: "m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2ZM19 17l.6 1.4L21 19l-1.4.6L19 21l-.6-1.4L17 19l1.4-.6L19 17Z",
  lock: "M5 10h14v11H5V10Zm3 0V7a4 4 0 0 1 8 0v3",
  chevron: "m9 18 6-6-6-6",
} as const;
function Icon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
function groupName(timestamp: number) {
  const day = new Date(timestamp).toDateString();
  if (day === new Date().toDateString()) return "Today";
  if (day === new Date(Date.now() - 86400000).toDateString()) return "Yesterday";
  return "Previous";
}
const quickStarts = ["Help me plan my day", "Summarize what we worked on recently", "I have an idea to think through"];
type Attachment = { url: string; fileName: string; contentType: string };
type PendingAttachment = Attachment & { id: Id<"chatAttachments"> };
type ModelChoice = { engine: "codex" | "gateway"; model?: string };
function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  if (!attachments.length) return null;
  return <div className="chat-attachments">{attachments.map((attachment) => {
    if (attachment.contentType.startsWith("image/")) return <a key={attachment.url} href={attachment.url} target="_blank" rel="noreferrer"><img src={attachment.url} alt={attachment.fileName} /></a>;
    if (attachment.contentType.startsWith("video/")) return <video key={attachment.url} controls preload="metadata" src={attachment.url} />;
    if (attachment.contentType.startsWith("audio/")) return <audio key={attachment.url} controls src={attachment.url} />;
    return <a className="chat-attachment-file" key={attachment.url} href={attachment.url} target="_blank" rel="noreferrer"><Icon name="paperclip" size={15} />{attachment.fileName}</a>;
  })}</div>;
}

export function Chat({ dashboardKey, onNavigate, onLock }: {
  dashboardKey: string;
  onNavigate: (tab: "work" | "computer" | "connectors" | "memory" | "settings" | "activity" | "keys" | "setup") => void;
  onLock: () => void;
}) {
  const chats = useQuery(api.dashboard.listChats, { key: dashboardKey });
  const createChat = useMutation(api.dashboard.createChat);
  const renameChat = useMutation(api.dashboard.renameChat);
  const deleteChat = useMutation(api.dashboard.deleteChat);
  const branchChat = useAction(api.dashboard.branchChat);
  const sendChat = useMutation(api.dashboard.sendChat);
  const generateUploadUrl = useMutation(api.dashboard.generateUploadUrl);
  const registerAttachment = useMutation(api.dashboard.registerAttachment);
  const modelOptions = useQuery(api.models.options, { key: dashboardKey });
  const listGatewayModels = useAction(api.models.gatewayModels);
  const setChatModel = useMutation(api.dashboard.setChatModel).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.dashboard.getChat, { key: args.key, id: args.id });
    if (current) store.setQuery(api.dashboard.getChat, { key: args.key, id: args.id }, { ...current, engine: args.engine, model: args.model });
  });
  const [gatewayModels, setGatewayModels] = useState<Array<{ id: string; name: string }>>([]);
  const [draftChoice, setDraftChoice] = useState<ModelChoice | null>(null);
  const [selectedId, setSelectedId] = useState<ChatId | null>(null);
  const [restored, setRestored] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<{ id: ChatId; text: string; attachments: Attachment[]; baselineCount: number; seenRunning: boolean } | null>(null);
  const [pickedFiles, setPickedFiles] = useState<File[]>([]);
  const [pickedPreviews, setPickedPreviews] = useState<Map<File, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<Array<{ id: ChatId; title: string; snippet: string; lastMessageAt: number }> | null>(null);
  const [searchError, setSearchError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [menuId, setMenuId] = useState<ChatId | null>(null);
  const [renameId, setRenameId] = useState<ChatId | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteId, setDeleteId] = useState<ChatId | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const olderScroll = useRef<{ height: number; top: number } | null>(null);
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
  const searchChats = useAction(api.dashboard.searchChats);

  useEffect(() => {
    const match = window.location.pathname.match(/^\/chat\/([^/]+)/);
    const fromUrl = match ? decodeURIComponent(match[1]) as ChatId : null;
    setSelectedId(fromUrl ?? window.localStorage.getItem("perry.activeChat") as ChatId | null);
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return;
    if (selectedId) {
      window.localStorage.setItem("perry.activeChat", selectedId);
      if (window.location.pathname !== `/chat/${encodeURIComponent(selectedId)}`) {
        window.history.replaceState(null, "", `/chat/${encodeURIComponent(selectedId)}`);
      }
    } else {
      window.localStorage.removeItem("perry.activeChat");
      if (window.location.pathname.startsWith("/chat")) window.history.replaceState(null, "", "/");
    }
  }, [restored, selectedId]);
  useEffect(() => { if (selectedId) draftingNew.current = false; }, [selectedId]);
  useEffect(() => {
    if (!chats || !restored || draftingNew.current) return;
    if (selectedId && chats.some((item) => item.id === selectedId)) return;
    setSelectedId(chats[0]?.id ?? null);
  }, [chats, restored]);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchTerm(search.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!searchTerm) { setSearchResults(null); setSearchError(""); return; }
    let current = true;
    setSearchResults(null);
    setSearchError("");
    void searchChats({ key: dashboardKey, search: searchTerm })
      .then((results) => { if (current) setSearchResults(results); })
      .catch((cause) => { if (current) setSearchError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { current = false; };
  }, [dashboardKey, searchChats, searchTerm]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); }
      if (event.key === "Escape") { setSearchOpen(false); setMenuId(null); setRenameId(null); setDeleteId(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!pending || pending.id !== selectedId) return;
    const count = messages.filter((message) => message.role === "user" && message.text === pending.text).length;
    if (count > pending.baselineCount) setPending(null);
  }, [messages, pending, selectedId]);
  useEffect(() => {
    if (!pending || pending.id !== selectedId) return;
    if (chat?.isRunning && !pending.seenRunning) setPending((current) =>
      current?.id === pending.id && current.text === pending.text ? { ...current, seenRunning: true } : current,
    );
    if (pending.seenRunning && chat?.isRunning === false) setPending((current) =>
      current?.id === pending.id && current.text === pending.text ? null : current,
    );
  }, [chat?.isRunning, pending, selectedId]);
  useEffect(() => {
    let current = true;
    void listGatewayModels({ key: dashboardKey })
      .then((models) => { if (current) setGatewayModels(models); })
      .catch(() => { if (current) setGatewayModels([]); });
    return () => { current = false; };
  }, [dashboardKey, listGatewayModels]);
  useEffect(() => {
    const previews = new Map(pickedFiles.map((file) => [file, URL.createObjectURL(file)]));
    setPickedPreviews(previews);
    return () => previews.forEach((url) => URL.revokeObjectURL(url));
  }, [pickedFiles]);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    if (olderScroll.current) {
      element.scrollTop = olderScroll.current.top + element.scrollHeight - olderScroll.current.height;
      olderScroll.current = null;
    } else {
      element.scrollTop = element.scrollHeight;
    }
  }, [selectedId, messages.length, pending]);

  const active = chats?.find((item) => item.id === selectedId);
  const parent = chats?.find((item) => item.id === active?.parentConversationId);
  const waiting = Boolean(pending?.id === selectedId) || Boolean(chat?.isRunning);
  const stored = selectedId ? (chat?.engine ? { engine: chat.engine, model: chat.model } : null) : draftChoice;
  const choiceEngine = stored?.engine ?? modelOptions?.defaultEngine ?? "codex";
  const gatewayDefault = modelOptions?.gatewayDefaults[chat?.mode ?? "perry"];
  const choice: ModelChoice = {
    engine: choiceEngine,
    model: stored?.model ?? (choiceEngine === "codex"
      ? (modelOptions?.codex.find((item) => item.isDefault) ?? modelOptions?.codex[0])?.id
      : gatewayDefault),
  };
  const gatewayChoices = [...gatewayModels];
  for (const id of [gatewayDefault, choice.engine === "gateway" ? choice.model : undefined]) {
    if (id && !gatewayChoices.some((item) => item.id === id)) gatewayChoices.unshift({ id, name: id });
  }
  function pickModel(value: string) {
    const split = value.indexOf(":");
    const next: ModelChoice = { engine: value.slice(0, split) as ModelChoice["engine"], model: value.slice(split + 1) || undefined };
    if (!selectedId) { setDraftChoice(next); return; }
    void setChatModel({ key: dashboardKey, id: selectedId, ...next }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }

  function startNewChat() {
    draftingNew.current = true;
    setSelectedId(null);
    setDraft("");
    setError("");
    setSidebarOpen(false);
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return null; }
    finally { setBusy(false); }
  }
  async function submit(text = draft) {
    const message = text.trim();
    if ((!message && pickedFiles.length === 0) || busy || pending?.id === selectedId) return;
    const id = selectedId ?? await makeChat();
    if (!id) return;
    const files = pickedFiles;
    const messageKey = files.length ? crypto.randomUUID() : undefined;
    setDraft(""); setPickedFiles([]); setError("");
    try {
      const uploaded: PendingAttachment[] = [];
      for (const file of files) {
        const uploadUrl = await generateUploadUrl({ key: dashboardKey });
        const response = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
        if (!response.ok) throw new Error(`Could not upload ${file.name}.`);
        const body = await response.json() as { storageId?: Id<"_storage"> };
        if (!body.storageId) throw new Error(`Could not store ${file.name}.`);
        const attachmentId = await registerAttachment({ key: dashboardKey, conversationId: id, messageKey: messageKey!, storageId: body.storageId, fileName: file.name, contentType: file.type || "application/octet-stream", size: file.size });
        uploaded.push({ id: attachmentId, url: URL.createObjectURL(file), fileName: file.name, contentType: file.type || "application/octet-stream" });
      }
      setPending({ id, text: message, attachments: uploaded, baselineCount: selectedId === id ? messages.filter((item) => item.role === "user" && item.text === message).length : 0, seenRunning: false });
      await sendChat({ key: dashboardKey, id, text: message, attachmentIds: uploaded.map((item) => item.id), messageKey, engine: choice.engine, model: choice.model });
    } catch (cause) { setPending(null); setDraft(message); setPickedFiles(files); setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  async function branch(messageId: string) {
    if (!selectedId || busy) return;
    setBusy(true); setError("");
    try {
      const id = await branchChat({ key: dashboardKey, id: selectedId, messageId });
      draftingNew.current = false;
      setSelectedId(id); setSidebarOpen(false); window.setTimeout(() => composer.current?.focus(), 0);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function saveName() {
    if (!renameId) return;
    setBusy(true);
    try { await renameChat({ key: dashboardKey, id: renameId, title: renameValue }); setRenameId(null); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  async function removeChat() {
    if (!deleteId) return;
    const deleting = deleteId;
    const wasSelected = selectedId === deleting;
    if (wasSelected) setSelectedId(chats?.find((item) => item.id !== deleting)?.id ?? null);
    setBusy(true);
    try {
      await deleteChat({ key: dashboardKey, id: deleting });
      setDeleteId(null); setError("");
    } catch (cause) { if (wasSelected) setSelectedId(deleting); setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  const groups = ["Today", "Yesterday", "Previous"];
  const navigation = [
    { label: "Work", tab: "work" as const }, { label: "Computer", tab: "computer" as const },
    { label: "Connectors", tab: "connectors" as const }, { label: "Memory", tab: "memory" as const },
    { label: "Settings", tab: "settings" as const }, { label: "Activity", tab: "activity" as const },
  ];

  return <div className="chat-workspace">
    {sidebarOpen && <button className="chat-scrim" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}
    <aside className={`chat-sidebar ${sidebarOpen ? "open" : ""}`}>
      <div className="chat-brand"><span className="chat-brand-mark">A</span><span>Assistant</span><span className="chat-brand-sub">your space</span></div>
      <div className="chat-sidebar-actions">
        <button className="chat-new" onClick={startNewChat} disabled={busy}><Icon name="plus" size={19} /> New chat</button>
        <button className="chat-search-trigger" onClick={() => setSearchOpen(true)}><Icon name="search" size={17} /><span>Search chats</span><kbd>Ctrl K</kbd></button>
      </div>
      <div className="chat-sidebar-scroll">
        <div className="chat-sidebar-label">Your conversations <span>{chats?.length ?? 0}</span></div>
        {chats === undefined && <div className="chat-list-empty">Loading chats…</div>}
        {chats?.length === 0 && <div className="chat-list-empty">Your chats will show up here.</div>}
        {groups.map((group) => {
          const items = chats?.filter((item) => groupName(item.lastMessageAt) === group) ?? [];
          if (!items.length) return null;
          return <div className="chat-group" key={group}><div className="chat-group-label">{group}</div>
            {items.map((item) => <div key={item.id} className={`chat-list-item ${selectedId === item.id ? "selected" : ""}`}>
              <button className="chat-list-select" onClick={() => { draftingNew.current = false; setSelectedId(item.id); setSidebarOpen(false); setMenuId(null); setError(""); }}>
                <Icon name={item.parentConversationId ? "branch" : "chat"} size={16} />
                <span className="chat-list-text" title={`${item.title} · ${item.id}`}>
                  <span>{item.title}</span><small>Session {item.id.slice(-8)}</small>
                </span>
              </button>
              <button className="chat-list-more" aria-label={`Actions for ${item.title}`} onClick={() => setMenuId(menuId === item.id ? null : item.id)}><Icon name="more" size={17} /></button>
              {menuId === item.id && <div className="chat-item-menu">
                <button onClick={() => { setError(""); setRenameId(item.id); setRenameValue(item.title); setMenuId(null); }}><Icon name="pencil" size={15} /> Rename</button>
                <button className="danger" onClick={() => { setError(""); setDeleteId(item.id); setMenuId(null); }}><Icon name="trash" size={15} /> Delete</button>
              </div>}
            </div>)}
          </div>;
        })}
      </div>
      <div className="chat-sidebar-footer">
        <div className="chat-sidebar-label">Workspace</div>
        <div className="chat-nav-grid">{navigation.map((item) => <button key={item.tab} onClick={() => onNavigate(item.tab)}>{item.label}<Icon name="chevron" size={14} /></button>)}</div>
        <div className="chat-sidebar-bottom"><button onClick={() => onNavigate("keys")}>Keys</button><button onClick={() => onNavigate("setup")}>Setup</button><button onClick={onLock}><Icon name="lock" size={14} /> Lock</button></div>
      </div>
    </aside>
    <main className="chat-main">
      <header className="chat-header">
        <div className="chat-header-left">
          <button className="chat-mobile-menu" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button>
          <div className="chat-header-title">
            <strong>{active?.title ?? "New chat"}</strong>
            {selectedId && <div className="chat-header-meta">
              <button className="chat-session-id" title={selectedId} onClick={() => void navigator.clipboard.writeText(selectedId).catch((cause) => setError(String(cause)))}>
                Session {selectedId.slice(-8)} · Copy ID
              </button>
              {active?.parentConversationId && <button className="chat-parent-link" disabled={!parent} onClick={() => { if (parent) { draftingNew.current = false; setSelectedId(parent.id); } }}><Icon name="branch" size={13} /> From {parent?.title ?? "deleted chat"}</button>}
            </div>}
          </div>
        </div>
        <div className="chat-header-controls">
          <button className="chat-header-new" title="New chat" aria-label="New chat" onClick={startNewChat} disabled={busy}><Icon name="plus" /></button>
        </div>
      </header>
      <div className="chat-scroll" ref={scroller}>
        {!selectedId ? <div className="chat-welcome"><div className="chat-welcome-mark"><Icon name="spark" size={33} /></div><div className="chat-eyebrow">YOUR PERSONAL ASSISTANT</div><h1>Where should we start?</h1><p>Ask a question, make a plan, or pick up where you left off. Your assistant remembers what matters across your chats.</p><div className="chat-prompts">{quickStarts.map((prompt) => <button key={prompt} onClick={() => { setDraft(prompt); composer.current?.focus(); }}>{prompt}<Icon name="chevron" size={15} /></button>)}</div></div> :
          <div className="chat-thread">
            {(chat === undefined || messageStatus === "LoadingFirstPage") && <div className="chat-thread-loading">Loading conversation…</div>}
            {messageStatus === "CanLoadMore" && <div className="chat-load-older"><button onClick={() => { if (scroller.current) olderScroll.current = { height: scroller.current.scrollHeight, top: scroller.current.scrollTop }; loadMore(50); }}>Load earlier messages</button></div>}
            {messageStatus === "LoadingMore" && <div className="chat-thread-loading">Loading earlier messages…</div>}
            {chat && messageStatus !== "LoadingFirstPage" && messages.length === 0 && pending?.id !== selectedId && <div className="chat-thread-empty"><div className="chat-welcome-mark small"><Icon name="spark" size={24} /></div><h2>Start a conversation</h2><p>Messages in this chat stay together. Your saved memories are available in every chat.</p></div>}
            {messages.map((message) => <div key={message.id} className={`chat-turn ${message.role === "user" ? "from-user" : "from-assistant"}`}>
              {message.role !== "user" && <div className="chat-avatar">A</div>}
              <div className="chat-turn-body"><div className="chat-bubble">{message.text}<AttachmentList attachments={message.attachments ?? []} /></div><div className="chat-turn-actions"><button title="Branch from this message" onClick={() => void branch(message.id)} disabled={busy}><Icon name="branch" size={14} /> Branch from here</button></div></div>
            </div>)}
            {pending?.id === selectedId && <div className="chat-turn from-user pending"><div className="chat-turn-body"><div className="chat-bubble">{pending.text}<AttachmentList attachments={pending.attachments} /></div></div></div>}
            {waiting && <div className="chat-turn from-assistant pending"><div className="chat-avatar">A</div><div className="chat-thinking"><i /><i /><i /></div></div>}
            {chat?.lastError && !chat.isRunning && <div className="chat-turn-error" role="alert">The assistant couldn’t finish the last reply: {chat.lastError}</div>}
          </div>}
      </div>
      <div className="chat-composer-area"><div className="chat-composer-wrap">
        {error && <div className="chat-error" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError("")}><Icon name="close" size={15} /></button></div>}
        <div className="chat-composer-box">{pickedFiles.length > 0 && <div className="chat-picked-files">{pickedFiles.map((file, index) => {
          const url = pickedPreviews.get(file);
          const preview = url && file.type.startsWith("image/") ? <img src={url} alt={file.name} />
            : url && file.type.startsWith("video/") ? <video src={url} muted playsInline preload="metadata" />
            : <span className="chat-picked-name"><Icon name="paperclip" size={14} />{file.name}</span>;
          return <div className="chat-picked-file" key={`${index}-${file.name}-${file.lastModified}`} title={file.name}>{preview}<button aria-label={`Remove ${file.name}`} onClick={() => setPickedFiles((items) => items.filter((item) => item !== file))}><Icon name="close" size={12} /></button></div>;
        })}</div>}<textarea ref={composer} value={draft} rows={1} placeholder="Message your assistant…" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} /><div className="chat-composer-foot"><button className="chat-attach" aria-label="Attach files" title="Attach images, video, audio, or files" onClick={() => filePicker.current?.click()} disabled={busy}><Icon name="paperclip" size={17} /></button><input ref={filePicker} type="file" multiple hidden accept="image/*,video/*,audio/*,.pdf,.txt,.md,.csv,.json" onChange={(event) => { const files = Array.from(event.target.files ?? []); setPickedFiles((items) => [...items, ...files].slice(0, 10)); event.currentTarget.value = ""; }} /><select className="chat-model" aria-label="Model" title={`${choice.engine === "codex" ? "Codex subscription" : "AI Gateway"} · ${choice.model ?? "default"}`} value={`${choice.engine}:${choice.model ?? ""}`} onChange={(event) => pickModel(event.target.value)}>
          <optgroup label="Codex subscription">{modelOptions?.codex.length
            ? modelOptions.codex.map((item) => <option key={item.id} value={`codex:${item.id}`}>{item.name}</option>)
            : <option value="codex:">Codex default</option>}</optgroup>
          <optgroup label="AI Gateway">{gatewayChoices.map((item) => <option key={item.id} value={`gateway:${item.id}`}>{item.name === item.id ? item.id : `${item.name} · ${item.id.split("/")[0]}`}</option>)}</optgroup>
        </select><span className="chat-composer-hint">Shift + Enter for a new line</span><button className="chat-send" aria-label="Send message" onClick={() => void submit()} disabled={(!draft.trim() && pickedFiles.length === 0) || busy || pending?.id === selectedId}><Icon name="arrow" size={18} /></button></div></div>
        <div className="chat-composer-caption">Attach images, video, audio, or documents. The assistant can inspect supported files and link to shared media.</div>
      </div></div>
    </main>
    {searchOpen && <div className="chat-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchOpen(false); }}><div className="chat-search-dialog" role="dialog" aria-modal="true" aria-label="Search chats"><div className="chat-search-field"><Icon name="search" size={20} /><input autoFocus value={search} placeholder="Search your chats…" onChange={(event) => setSearch(event.target.value)} /><button onClick={() => setSearchOpen(false)} aria-label="Close search"><Icon name="close" size={17} /></button></div><div className="chat-search-results">{!searchTerm && <div className="chat-search-help">Find a conversation by title or message text.</div>}{searchTerm && searchResults === null && !searchError && <div className="chat-search-help">Searching…</div>}{searchError && <div className="chat-search-help">{searchError}</div>}{searchTerm && searchResults?.length === 0 && <div className="chat-search-help">No chats found for “{searchTerm}”.</div>}{searchResults?.map((item) => <button key={item.id} onClick={() => { setSelectedId(item.id); setSearchOpen(false); setSidebarOpen(false); }}><Icon name="chat" size={17} /><span><strong>{item.title}</strong>{item.snippet && <small>{item.snippet}</small>}</span><Icon name="chevron" size={16} /></button>)}</div><div className="chat-search-tip">ESC to close</div></div></div>}
    {renameId && <div className="chat-modal-backdrop"><form className="chat-confirm-dialog" onSubmit={(event) => { event.preventDefault(); void saveName(); }}><h2>Rename chat</h2><p>Give this conversation a name that is easy to find later.</p><input autoFocus value={renameValue} maxLength={100} onChange={(event) => setRenameValue(event.target.value)} />{error && <div className="chat-dialog-error" role="alert">{error}</div>}<div className="chat-dialog-actions"><button type="button" onClick={() => setRenameId(null)}>Cancel</button><button className="chat-dialog-primary" type="submit" disabled={!renameValue.trim() || busy}>Save name</button></div></form></div>}
    {deleteId && <div className="chat-modal-backdrop"><div className="chat-confirm-dialog" role="alertdialog" aria-modal="true"><h2>Delete this chat?</h2><p>This removes the conversation and its messages. This cannot be undone.</p>{error && <div className="chat-dialog-error" role="alert">{error}</div>}<div className="chat-dialog-actions"><button onClick={() => setDeleteId(null)}>Cancel</button><button className="chat-dialog-danger" onClick={() => void removeChat()} disabled={busy}>Delete chat</button></div></div></div>}
  </div>;
}
