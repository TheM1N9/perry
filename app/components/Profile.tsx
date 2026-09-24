"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { PROFILE_GROUPS, SECTIONS, linkClick, sectionPath, type SectionId } from "./Sidebar";
import { Icon, Loading, Section, Status } from "./ui";

/**
 * Everything you visit rather than use every day.
 *
 * The sidebar keeps only your chats and Work; memory, connected accounts, the
 * computer, the activity log and configuration are all one click from here.
 */
export function Profile({ dashboardKey, onNavigate }: { dashboardKey: string; onNavigate: (section: SectionId) => void }) {
  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });

  if (status === undefined) return <Section title="You"><Loading /></Section>;

  const name = status.ownerName ?? "You";
  const link = (id: SectionId) => {
    const section = SECTIONS.find((entry) => entry.id === id)!;
    return <a key={id} className="item item-link" href={sectionPath(id)} onClick={(event) => linkClick(event, () => onNavigate(id))}>
      <span className="item-icon" aria-hidden="true"><Icon name={section.icon} size={16} /></span>
      <span className="item-main">
        <span className="item-title">{section.label}</span>
        <span className="item-text">{section.description}</span>
      </span>
      <span className="item-link-side">
        {id === "memory" && <span className="section-count">{status.memories}</span>}
        {id === "setup" && !status.claimed && <Status tone="warning">Unpaired</Status>}
        <Icon name="chevron" size={15} />
      </span>
    </a>;
  };

  return <>
    <div className="profile-card">
      <span className="avatar avatar-lg" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
      <div className="profile-card-main">
        <div className="profile-card-name">{name}</div>
        <div className="item-meta">
          <span>{status.claimed ? "Paired on Telegram" : "Not paired yet"}</span>
          <span>{status.memories} {status.memories === 1 ? "memory" : "memories"}</span>
        </div>
      </div>
      {!status.claimed && <a className="btn btn-primary btn-sm" href={sectionPath("setup")} onClick={(event) => linkClick(event, () => onNavigate("setup"))}>Pair Perry</a>}
    </div>
    {PROFILE_GROUPS.map((group) => <Section key={group.label} title={group.label}>{group.ids.map(link)}</Section>)}
  </>;
}
