"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { SectionId } from "../sections";
import { PERSONALITIES } from "./Welcome";
import { ActionButton, Empty, Loading, RelativeTime, Section, Spinner, errorText, useToast } from "./ui";

const BY = { owner: "You", assistant: "Your assistant", job: "A scheduled job" } as const;

/**
 * USER.md and the assistant's identity, after the welcome page: edit either,
 * see who changed what and when, and bring an older version back.
 */
export function AboutYou({ dashboardKey, onNavigate }: { dashboardKey: string; onNavigate: (section: SectionId) => void }) {
  const toast = useToast();
  const persona = useQuery(api.dashboard.getPersona, { key: dashboardKey });
  const userHistory = useQuery(api.dashboard.personaHistory, { key: dashboardKey, kind: "user" });
  const identityHistory = useQuery(api.dashboard.personaHistory, { key: dashboardKey, kind: "identity" });
  const saveUserMd = useMutation(api.dashboard.saveUserMd);
  const saveIdentity = useMutation(api.dashboard.saveIdentity);
  const restore = useMutation(api.dashboard.restorePersonaVersion);
  const redo = useMutation(api.dashboard.redoOnboarding);

  const [userMd, setUserMd] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [personality, setPersonality] = useState<string | null>(null);
  const [saving, setSaving] = useState<"" | "user" | "identity">("");

  // A draft follows the saved text until it is edited, so a change made elsewhere (by the assistant, or a restore) shows up.
  const savedUser = persona?.user ?? "";
  const draftUser = userMd ?? savedUser;
  const draftName = name ?? persona?.name ?? "";
  const draftPersonality = personality ?? persona?.personality ?? "";
  useEffect(() => { if (userMd === savedUser) setUserMd(null); }, [userMd, savedUser]);

  if (persona === undefined) return <Section title="Your assistant"><Loading /></Section>;

  const submitIdentity = async (event: FormEvent) => {
    event.preventDefault();
    setSaving("identity");
    try {
      const { changed } = await saveIdentity({ key: dashboardKey, name: draftName, personality: draftPersonality });
      setName(null); setPersonality(null);
      toast({ tone: "success", text: changed ? "Saved. It applies from the next reply." : "Nothing changed." });
    } catch (cause) {
      toast({ tone: "danger", text: errorText(cause) });
    } finally {
      setSaving("");
    }
  };

  const submitUser = async (event: FormEvent) => {
    event.preventDefault();
    setSaving("user");
    try {
      const { changed } = await saveUserMd({ key: dashboardKey, text: draftUser });
      setUserMd(null);
      toast({ tone: "success", text: changed ? "Saved. It applies from the next reply." : "Nothing changed." });
    } catch (cause) {
      toast({ tone: "danger", text: errorText(cause) });
    } finally {
      setSaving("");
    }
  };

  const identityDirty = draftName.trim() !== persona.name || draftPersonality.trim() !== persona.personality;
  const userDirty = draftUser.trim() !== savedUser.trim();
  const restoreButton = (id: string, what: string) => <ActionButton variant="ghost" action={() => restore({ key: dashboardKey, id: id as Id<"persona"> })}
    success="Restored. The version it replaced stays in history."
    confirm={{ title: `Restore this ${what}?`, body: "It becomes the current version. What it replaces stays in history, so you can switch back.", confirmLabel: "Restore", danger: false }}>Restore</ActionButton>;

  return <>
    <Section title="Your assistant" description="Its name and how it comes across. Both go into every chat.">
      <form className="section-pad" onSubmit={(event) => void submitIdentity(event)}>
        <div className="field">
          <label htmlFor="identity-name">Name</label>
          <input id="identity-name" className="input" value={draftName} maxLength={40} placeholder={persona.defaultName} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="identity-personality">Personality</label>
          <textarea id="identity-personality" className="textarea" rows={3} maxLength={600} value={draftPersonality} placeholder="Leave empty for the default: direct, clear and concise." onChange={(event) => setPersonality(event.target.value)} />
          <div className="welcome-chips" role="group" aria-label="Start from a preset">
            {PERSONALITIES.map((item) => <button type="button" key={item.id} className="btn btn-ghost btn-sm" onClick={() => setPersonality(item.text)}>{item.label}</button>)}
          </div>
        </div>
        <button type="submit" className="btn btn-primary btn-md" disabled={!identityDirty || saving === "identity"} aria-busy={saving === "identity" || undefined}>
          {saving === "identity" && <Spinner />}{saving === "identity" ? "Saving…" : "Save"}
        </button>
      </form>
    </Section>

    <Section title="USER.md" description={`Who you are, in your words. ${persona.name} reads all of it before every reply and keeps it current as you talk.`}>
      <form className="section-pad" onSubmit={(event) => void submitUser(event)}>
        <div className="field">
          <label htmlFor="user-md" className="sr-only">USER.md</label>
          <textarea id="user-md" className="textarea welcome-md" rows={16} value={draftUser} placeholder={"# About you\n\n## Work\n\n## A typical day\n\n…"} onChange={(event) => setUserMd(event.target.value)} />
          {userHistory?.[0] && <p className="field-hint">Last changed by {BY[userHistory[0].by].toLowerCase()} <RelativeTime at={userHistory[0].createdAt} />.</p>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="submit" className="btn btn-primary btn-md" disabled={!userDirty || saving === "user"} aria-busy={saving === "user" || undefined}>
            {saving === "user" && <Spinner />}{saving === "user" ? "Saving…" : "Save"}
          </button>
          {userDirty && <button type="button" className="btn btn-ghost btn-md" onClick={() => setUserMd(null)}>Discard changes</button>}
        </div>
      </form>
    </Section>

    <Section title="History" description="Every saved version, newest first. Restoring one keeps the version it replaces.">
      {(userHistory === undefined || identityHistory === undefined) && <Loading />}
      {userHistory?.length === 0 && identityHistory?.length === 0 && <Empty icon="redo" title="No versions yet">Saving either of the above starts the history.</Empty>}
      {userHistory?.map((version, index) => <div className="item" key={version.id}>
        <div className="item-main">
          <details>
            <summary className="item-title">USER.md{index === 0 ? " (current)" : ""}</summary>
            <pre className="welcome-md" style={{ whiteSpace: "pre-wrap", margin: "8px 0 0" }}>{version.text}</pre>
          </details>
          <div className="item-meta"><span>{BY[version.by]}</span><RelativeTime at={version.createdAt} /></div>
        </div>
        {index > 0 && <div className="item-side">{restoreButton(version.id, "USER.md")}</div>}
      </div>)}
      {identityHistory?.map((version, index) => <div className="item" key={version.id}>
        <div className="item-main">
          <div className="item-title">{version.name}{index === 0 ? " (current)" : ""}</div>
          {version.personality && <div className="item-text">{version.personality}</div>}
          <div className="item-meta"><span>{BY[version.by]}</span><RelativeTime at={version.createdAt} /></div>
        </div>
        {index > 0 && <div className="item-side">{restoreButton(version.id, "name and personality")}</div>}
      </div>)}
    </Section>

    <Section title="Start over" description="Go through the welcome page again. What you save there becomes the newest version; nothing is lost.">
      <div className="section-pad">
        <ActionButton action={async () => { await redo({ key: dashboardKey }); onNavigate("welcome"); }}>Open the welcome page</ActionButton>
      </div>
    </Section>
  </>;
}
