"use client";

import { useQuery } from "convex/react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { api } from "@/convex/_generated/api";
import { SECTIONS, type SectionId } from "../sections";
import { ChatList, ChatSearch, type ChatId } from "./ChatList";
import { Icon, Kbd, Status } from "./ui";

export { SECTIONS, type SectionId };

/** What you open every day besides your chats. Everything else is a visit, so it lives on the Profile page. */
const PRIMARY: SectionId[] = ["tasks"];

/** The Profile page's groups, in order. */
export const PROFILE_GROUPS: Array<{ label: string; ids: SectionId[] }> = [
  { label: "About you", ids: ["memory", "connectors"] },
  { label: "What Perry does", ids: ["activity", "computer"] },
  { label: "Configure", ids: ["settings", "keys", "setup"] },
];

/** Whether a section is reached from the Profile page rather than the sidebar. */
export const underProfile = (id: SectionId) => PROFILE_GROUPS.some((group) => group.ids.includes(id));

export const sectionPath = (id: SectionId) => `/${id}`;

/** Kept on the history entry: `newChat` opens the chat page on a blank chat rather than the last one. */
export type NavigationState = { newChat: true };

/** Plain clicks navigate in place; modified clicks keep the browser's own behavior. */
export function linkClick(event: MouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate();
}

/**
 * The same on every page: new chat, search, Work, your chats, and your profile.
 * The chat page passes the open chat and its own handlers; elsewhere, picking
 * a chat opens it on the chat page.
 */
export function Sidebar({ dashboardKey, current, onNavigate, onLock, open, onClose, selectedChat = null, onSelectChat, onNewChat }: {
  dashboardKey: string;
  current: SectionId;
  onNavigate: (section: SectionId, state?: NavigationState) => void;
  onLock: () => void;
  open: boolean;
  onClose: () => void;
  selectedChat?: ChatId | null;
  onSelectChat?: (id: ChatId) => void;
  onNewChat?: () => void;
}) {
  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  const ref = useRef<HTMLElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const selectChat = (id: ChatId) => {
    if (onSelectChat) onSelectChat(id);
    else { window.localStorage.setItem("perry.activeChat", id); onNavigate("chat"); }
    onClose();
  };
  const newChat = () => {
    if (onNewChat) onNewChat();
    else { window.localStorage.removeItem("perry.activeChat"); onNavigate("chat", { newChat: true }); }
    onClose();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // On small screens the sidebar is a drawer: Escape closes it, and focus moves in and back out.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    // A frame later, once the drawer is visible and the page behind it inert.
    const frame = window.setTimeout(() => ref.current?.querySelector<HTMLElement>("a, button")?.focus(), 0);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { window.clearTimeout(frame); window.removeEventListener("keydown", onKey); opener?.focus?.(); };
  }, [open, onClose]);

  const item = (id: SectionId) => {
    const section = SECTIONS.find((entry) => entry.id === id)!;
    return <a key={id} href={sectionPath(id)} className="nav-item" aria-current={current === id ? "page" : undefined}
      onClick={(event) => linkClick(event, () => { onNavigate(id); onClose(); })}>
      <Icon name={section.icon} size={15} />{section.label}
    </a>;
  };
  const onProfile = current === "profile" || underProfile(current);
  const name = status === undefined ? "" : status.ownerName ?? "You";

  return <>
    {open && <button type="button" className="scrim" aria-label="Close navigation" onClick={onClose} />}
    <aside ref={ref} className={`sidebar ${open ? "open" : ""}`} aria-label="Sidebar">
      <div className="sidebar-top">
        <a className="brand" href="/chat" onClick={(event) => linkClick(event, () => { onNavigate("chat"); onClose(); })}>
          <span className="brand-mark" aria-hidden="true">P</span><span translate="no">Perry</span>
        </a>
        <button type="button" className="icon-button sidebar-close" aria-label="Close navigation" onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="sidebar-actions">
        <button type="button" className="chat-new" onClick={newChat}><Icon name="plus" size={15} />New chat</button>
        <button type="button" className="chat-search-trigger" onClick={() => setSearchOpen(true)} aria-keyshortcuts="Control+K Meta+K"><Icon name="search" size={15} /><span>Search</span><Kbd>Ctrl K</Kbd></button>
        <nav aria-label="Main" className="chat-nav-grid">{PRIMARY.map(item)}</nav>
      </div>
      <div className="sidebar-scroll">
        <ChatList dashboardKey={dashboardKey} selectedId={selectedChat} onSelect={selectChat} onNew={newChat} />
      </div>
      <div className="sidebar-footer">
        <a className="profile-link" href={sectionPath("profile")} aria-current={onProfile ? "page" : undefined}
          onClick={(event) => linkClick(event, () => { onNavigate("profile"); onClose(); })}>
          <span className="avatar" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
          <span className="profile-link-text">
            <span className="profile-link-name">{name}</span>
            <span className="profile-link-meta">{status === undefined ? " " : status.claimed ? `${status.memories} memories` : "Not paired yet"}</span>
          </span>
          {status && !status.claimed && <Status tone="warning">Unpaired</Status>}
        </a>
        <button type="button" className="icon-button" onClick={onLock} aria-label="Lock dashboard" title="Lock dashboard"><Icon name="lock" size={15} /></button>
      </div>
    </aside>
    {searchOpen && <ChatSearch dashboardKey={dashboardKey} onClose={() => setSearchOpen(false)} onPick={(id) => { setSearchOpen(false); selectChat(id); }} />}
  </>;
}
