"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import type { BrowserRequest } from "@/lib/browser-protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const profilesResult = z.object({ profiles: z.array(z.object({ id: z.string(), name: z.string(), inUse: z.boolean() })), selected: z.string() });
export function BrowserProfiles({ call, changed }: { call(request: BrowserRequest): Promise<unknown>; changed(value: unknown): void }) {
  const [data, setData] = useState<z.infer<typeof profilesResult>>(), [selected, setSelected] = useState(""), [name, setName] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { let alive = true; void call({ action: "browserProfiles" }).then(value => { if (alive) { const data = profilesResult.parse(value); setData(data); setSelected(data.selected); } }).catch(cause => { if (alive) setError(String(cause)); }); return () => { alive = false; }; }, [call]);
  async function useProfile(create = false) {
    setBusy(true); setError("");
    try {
      const id = create ? z.object({ id: z.string() }).parse(await call({ action: "createProfile", name })).id : selected;
      changed(await call({ action: "selectProfile", profileId: id, transfer: true }));
      const updated = profilesResult.parse(await call({ action: "browserProfiles" })); setData(updated); setSelected(updated.selected); setName("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2" aria-label="Browser profiles">
    <p className="font-medium">Browser profiles</p>
    <p className="text-xs text-muted-foreground">Reuse sign-ins across chats. Using a profile here closes its browser in another chat and pauses that chat's browsing.</p>
    {data?.selected === "private" && <p className="text-xs text-muted-foreground">Create a named profile to keep this chat's existing sign-ins and reuse them elsewhere.</p>}
    <div className="flex gap-2"><select aria-label="Browser profile" className="min-w-0 flex-1 rounded-md border bg-background px-2 text-xs" value={selected} disabled={!data || busy} onChange={event => setSelected(event.target.value)}>{data?.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name}{profile.inUse ? " · Open in another chat" : ""}</option>)}</select><Button size="sm" disabled={!selected || busy} onClick={() => void useProfile()}>Use here</Button></div>
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void useProfile(true); }}><Input aria-label="New browser profile name" placeholder="New profile name" value={name} maxLength={80} onChange={event => setName(event.target.value)} /><Button type="submit" size="sm" variant="outline" disabled={!name.trim() || busy}>Create</Button></form>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}
