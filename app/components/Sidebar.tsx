"use client";

import { useQuery } from "convex/react";
import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import { SECTIONS, type SectionId } from "../sections";
import { Icon, Status } from "./ui";

export { SECTIONS, type SectionId };

const PRIMARY: SectionId[] = ["chat", "work", "computer", "connectors", "memory", "activity"];
const CONFIGURE: SectionId[] = ["settings", "keys", "setup"];

export const sectionPath = (id: SectionId) => `/${id}`;

/** Plain clicks navigate in place; modified clicks keep the browser's own behavior. */
export function linkClick(event: MouseEvent<HTMLAnchorElement>, navigate: () => void) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate();
}

export function Sidebar({ dashboardKey, current, onNavigate, onLock, open, onClose, actions, children }: {
  dashboardKey: string;
  current: SectionId;
  onNavigate: (section: SectionId) => void;
  onLock: () => void;
  open: boolean;
  onClose: () => void;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  const ref = useRef<HTMLElement>(null);

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
    return <a key={id} href={id === "chat" ? "/chat" : sectionPath(id)} className="nav-item" aria-current={current === id ? "page" : undefined}
      onClick={(event) => linkClick(event, () => { onNavigate(id); onClose(); })}>
      <Icon name={section.icon} size={15} />{section.label}
      {id === "setup" && status && !status.claimed && <span className="nav-item-meta"><Status tone="warning">Unpaired</Status></span>}
    </a>;
  };

  return <>
    {open && <button type="button" className="scrim" aria-label="Close navigation" onClick={onClose} />}
    <aside ref={ref} className={`sidebar ${open ? "open" : ""}`} aria-label="Sidebar">
      <div className="sidebar-top">
        <a className="brand" href="/chat" onClick={(event) => linkClick(event, () => { onNavigate("chat"); onClose(); })}>
          <span className="brand-mark" aria-hidden="true">P</span><span translate="no">Perry</span>
        </a>
        <button type="button" className="icon-button sidebar-close" aria-label="Close navigation" onClick={onClose}><Icon name="close" /></button>
      </div>
      {actions && <div className="sidebar-actions">{actions}</div>}
      <div className="sidebar-scroll">
        <nav aria-label="Main" className="chat-nav-grid">{PRIMARY.map(item)}</nav>
        <div className="sidebar-label">Configure</div>
        <nav aria-label="Configure" className="chat-nav-grid">{CONFIGURE.map(item)}</nav>
        {children}
      </div>
      <div className="sidebar-footer">
        <span className="sidebar-status" title={status?.claimed ? `Paired${status.ownerName ? ` with ${status.ownerName}` : ""}` : undefined}>
          {status === undefined ? " " : status.claimed
            ? `${status.ownerName ? `${status.ownerName} · ` : ""}${status.memories} memories`
            : "Not paired yet"}
        </span>
        <button type="button" className="icon-button" onClick={onLock} aria-label="Lock dashboard" title="Lock dashboard"><Icon name="lock" size={15} /></button>
      </div>
    </aside>
  </>;
}
