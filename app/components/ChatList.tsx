"use client";

import { useAction, useMutation, useQuery } from "@/client/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { linkClick } from "./Sidebar";
import { Dialog, Icon, Kbd, Notice, Spinner, errorText, useToast } from "./ui";

export type ChatId = Id<"conversations">;

/** How many chats show before "Show more", so a long history stays scannable. */
const CHAT_PAGE = 30;

/** Wrap each match of `term` in <mark>. */
function highlight(text: string, term: string): ReactNode {
  if (!term) return text;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.split(new RegExp(`(${escaped})`, "ig")).map((part, index) => index % 2 ? <mark key={index}>{part}</mark> : part);
}

export function ChatSearch({ dashboardKey, onPick, onClose }: { dashboardKey: string; onPick: (id: ChatId) => void; onClose: () => void }) {
  const searchChats = useAction(api.dashboard.searchChats);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<Array<{ id: ChatId; title: string; snippet: string; lastMessageAt: number }> | null>(null);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(search.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (!term) { setResults(null); setError(""); return; }
    let current = true;
    setResults(null);
    setError("");
    void searchChats({ key: dashboardKey, search: term })
      .then((found) => { if (current) { setResults(found); setActive(0); } })
      .catch((cause) => { if (current) setError(errorText(cause)); });
    return () => { current = false; };
  }, [dashboardKey, searchChats, term]);

  const count = results?.length ?? 0;
  return <Dialog title={<span className="sr-only">Search chats</span>} className="search-dialog" onClose={onClose}>
    <div className="chat-search-field">
      <Icon name="search" size={16} />
      <input autoFocus value={search} placeholder="Search chats by title or message…" aria-label="Search chats" role="combobox" aria-expanded={count > 0} aria-controls="chat-search-results"
        aria-activedescendant={count > 0 ? `chat-search-${active}` : undefined} aria-autocomplete="list" autoComplete="off" spellCheck={false}
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => {
          if (!results?.length) return;
          if (event.key === "ArrowDown") { event.preventDefault(); setActive((active + 1) % count); }
          if (event.key === "ArrowUp") { event.preventDefault(); setActive((active - 1 + count) % count); }
          if (event.key === "Enter") { event.preventDefault(); onPick(results[active].id); }
        }} />
      {search && <button type="button" className="icon-button sm" aria-label="Clear search" onClick={() => setSearch("")}><Icon name="close" size={14} /></button>}
    </div>
    <div className="chat-search-results" id="chat-search-results" role="listbox" aria-label="Matching chats" aria-busy={Boolean(term) && results === null && !error}>
      {!term && <div className="chat-search-help">Find a conversation by its title or anything said in it.</div>}
      {term && results === null && !error && <div className="chat-search-help" role="status"><Spinner /> Searching…</div>}
      {error && <div className="chat-search-help" role="alert">Search failed: {error}</div>}
      {term && results?.length === 0 && <div className="chat-search-help" role="status">No chats match “{term}”.</div>}
      {results?.map((item, index) => <button type="button" key={item.id} id={`chat-search-${index}`} role="option" aria-selected={index === active} tabIndex={-1}
        onMouseMove={() => setActive(index)} onClick={() => onPick(item.id)}>
        <Icon name="chat" size={15} />
        <span><strong>{highlight(item.title, term)}</strong>{item.snippet && <small>{highlight(item.snippet, term)}</small>}</span>
        <small className="nums">{new Date(item.lastMessageAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</small>
      </button>)}
    </div>
    <div className="chat-search-tip" aria-hidden="true"><span><Kbd>↑</Kbd><Kbd>↓</Kbd> to move</span><span><Kbd>Enter</Kbd> to open</span><span><Kbd>Esc</Kbd> to close</span></div>
  </Dialog>;
}

/** A chat row's action menu, closed by Escape or a click anywhere else. */
function ChatMenu({ onRename, onDelete, onClose }: { onRename: () => void; onDelete: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.parentElement?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); (ref.current?.previousElementSibling as HTMLElement | null)?.focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const items = [...(ref.current?.querySelectorAll("button") ?? [])];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onPointer); document.removeEventListener("keydown", onKey, true); };
  }, [onClose]);
  return <div className="menu" role="menu" ref={ref}>
    <button type="button" role="menuitem" onClick={onRename}><Icon name="pencil" size={14} />Rename</button>
    <button type="button" role="menuitem" className="danger" onClick={onDelete}><Icon name="trash" size={14} />Delete</button>
  </div>;
}

/**
 * Every web chat, newest first, with rename and delete. It sits in the
 * sidebar on every page, so a chat is one click away wherever you are.
 */
export function ChatList({ dashboardKey, selectedId, onSelect, onNew }: {
  dashboardKey: string;
  /** The chat open right now, if the chat page is showing one. */
  selectedId: ChatId | null;
  onSelect: (id: ChatId) => void;
  onNew: () => void;
}) {
  const toast = useToast();
  const chats = useQuery(api.dashboard.listChats, { key: dashboardKey });
  const renameChat = useMutation(api.dashboard.renameChat);
  const deleteChat = useMutation(api.dashboard.deleteChat);
  const [shown, setShown] = useState(CHAT_PAGE);
  const [menuId, setMenuId] = useState<ChatId | null>(null);
  const [renameId, setRenameId] = useState<ChatId | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteId, setDeleteId] = useState<ChatId | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const closeMenu = useCallback(() => setMenuId(null), []);
  const deleting = chats?.find((item) => item.id === deleteId);

  async function saveName() {
    if (!renameId) return;
    setBusy(true); setDialogError("");
    try { await renameChat({ key: dashboardKey, id: renameId, title: renameValue }); setRenameId(null); }
    catch (cause) { setDialogError(errorText(cause)); }
    finally { setBusy(false); }
  }
  async function removeChat() {
    if (!deleteId) return;
    const removing = deleteId;
    const wasSelected = selectedId === removing;
    setBusy(true); setDialogError("");
    try {
      await deleteChat({ key: dashboardKey, id: removing });
      if (wasSelected) {
        const next = chats?.find((item) => item.id !== removing)?.id;
        if (next) onSelect(next); else onNew();
      }
      setDeleteId(null);
      toast({ tone: "success", text: "Chat deleted." });
    } catch (cause) { setDialogError(errorText(cause)); }
    finally { setBusy(false); }
  }

  return <>
    <div className="sidebar-label"><span>Chats</span></div>
    {chats === undefined && <div className="chat-list-empty" role="status">Loading chats…</div>}
    {chats?.length === 0 && <div className="chat-list-empty">Your chats will show up here.</div>}
    {chats && chats.length > 0 && <div className="chat-group" role="group" aria-label="Chats">
      {chats.slice(0, shown).map((item) => <div key={item.id} className={`chat-list-item ${selectedId === item.id ? "selected" : ""}`}>
        <a className="chat-list-select" href={`/chat/${encodeURIComponent(item.id)}`} aria-current={selectedId === item.id ? "page" : undefined} title={item.title}
          onClick={(event) => linkClick(event, () => { setMenuId(null); onSelect(item.id); })}>
          <span className="chat-list-text">{item.title}</span>
        </a>
        <button type="button" className="chat-list-more" aria-label={`Actions for ${item.title}`} aria-haspopup="menu" aria-expanded={menuId === item.id} onClick={() => setMenuId(menuId === item.id ? null : item.id)}><Icon name="more" size={15} /></button>
        {menuId === item.id && <ChatMenu onClose={closeMenu}
          onRename={() => { setDialogError(""); setRenameId(item.id); setRenameValue(item.title); setMenuId(null); }}
          onDelete={() => { setDialogError(""); setDeleteId(item.id); setMenuId(null); }} />}
      </div>)}
      {chats.length > shown && <button type="button" className="btn btn-ghost btn-sm chat-list-older" onClick={() => setShown(shown + CHAT_PAGE)}>Show {Math.min(CHAT_PAGE, chats.length - shown)} more</button>}
    </div>}
    {renameId && <Dialog title="Rename chat" description="A short name makes it easier to find later." onClose={() => { if (!busy) setRenameId(null); }}>
      <form onSubmit={(event) => { event.preventDefault(); void saveName(); }}>
        <label className="sr-only" htmlFor="rename-chat">Chat name</label>
        <input id="rename-chat" className="input" autoFocus value={renameValue} maxLength={100} autoComplete="off" onChange={(event) => setRenameValue(event.target.value)} />
        {dialogError && <p className="field-error" role="alert">{dialogError}</p>}
        <div className="dialog-actions"><button type="button" className="btn btn-secondary btn-md" onClick={() => setRenameId(null)} disabled={busy}>Cancel</button><button className="btn btn-primary btn-md" type="submit" disabled={!renameValue.trim() || busy}>{busy && <Spinner />}Save name</button></div>
      </form>
    </Dialog>}
    {deleteId && <Dialog role="alertdialog" title="Delete this chat?" description={<>“{deleting?.title ?? "This chat"}” and all its messages will be removed. This can&apos;t be undone.</>} onClose={() => { if (!busy) setDeleteId(null); }}>
      {dialogError && <Notice tone="danger">{dialogError}</Notice>}
      <div className="dialog-actions"><button type="button" className="btn btn-secondary btn-md" onClick={() => setDeleteId(null)} disabled={busy} autoFocus>Cancel</button><button type="button" className="btn btn-danger btn-md" onClick={() => void removeChat()} disabled={busy}>{busy && <Spinner />}Delete chat</button></div>
    </Dialog>}
  </>;
}
