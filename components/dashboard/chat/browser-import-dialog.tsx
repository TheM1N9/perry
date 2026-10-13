"use client";

import { useEffect, useState } from "react";
import { CookieIcon, HistoryIcon, KeyRoundIcon, PuzzleIcon } from "lucide-react";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { nativeImportProfiles, browserState, type BrowserRequest, type BrowserState, type NativeImportChoices } from "@/lib/browser-protocol";
import { InfoTip } from "../common";

const result = z.object({ state: browserState, imported: z.object({ cookies: z.number(), passwords: z.number(), history: z.number(), extensions: z.number() }) });
export function BrowserImportDialog({ open, onOpenChange, state, call, apply }: { open: boolean; onOpenChange: (open: boolean) => void; state: BrowserState | null; call: (request: BrowserRequest) => Promise<unknown>; apply: (state: BrowserState) => void }) {
  const [profiles, setProfiles] = useState<z.infer<typeof nativeImportProfiles>>([]);
  const [profile, setProfile] = useState("");
  const [choices, setChoices] = useState<NativeImportChoices>({ cookies: true, passwords: true, history: false, extensions: false });
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError(""); setConfirmed(false); setProfiles([]); setProfile("");
    void call({ action: "nativeProfiles" }).then(value => {
      if (cancelled) return;
      const next = nativeImportProfiles.parse(value); setProfiles(next); setProfile(next[0]?.id ?? "");
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Couldn't find browser profiles."); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, call]);
  const source = profiles.find(item => item.id === profile);
  const rows = [{ name: "Saved passwords", key: "passwords", icon: KeyRoundIcon }, { name: "Cookies", key: "cookies", icon: CookieIcon }, { name: "Browsing history", key: "history", icon: HistoryIcon }, { name: "Extensions", key: "extensions", icon: PuzzleIcon }] as const;
  async function importData() {
    if (!state?.identity) return;
    setBusy(true); setError("");
    try { const next = result.parse(await call({ action: "nativeImport", identity: state.identity, profileId: profile, choices, confirmed: true })); apply(next.state); toast.success(`Imported ${Object.entries(next.imported).filter(([key]) => choices[key as keyof NativeImportChoices]).map(([key, count]) => `${count} ${key === "history" ? "history entries" : key}`).join(", ")}.`); onOpenChange(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Import failed."); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>Import from your browser</DialogTitle><DialogDescription>Into Perry’s separate browser.</DialogDescription></DialogHeader>
      <Select value={profile || null} items={profiles.map(item => ({ value: item.id, label: `${item.browser} · ${item.label}` }))} onValueChange={value => { if (typeof value === "string") { setProfile(value); setConfirmed(false); } }} disabled={busy || loading}>
        <SelectTrigger className="w-full" aria-label="Import source profile"><SelectValue placeholder={loading ? "Finding profiles…" : "Choose a profile"} /></SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>{profiles.map(item => <SelectItem key={item.id} value={item.id}>{item.browser} · {item.label}</SelectItem>)}</SelectContent>
      </Select>
      {!loading && !profiles.length && !error && <p className="text-xs text-muted-foreground">No supported Chrome profile found on this Windows computer.</p>}
      <p className="text-xs text-muted-foreground">Close Google Chrome before importing.</p>
      <div className="divide-y rounded-lg border px-3">{rows.map(({ name, key, icon: Icon }) => <label key={key} className="flex items-center gap-3 py-3">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden /><span className="flex-1"><span id={`browser-import-${key}`}>{name}</span>{key === "extensions" && <InfoTip>Imports supported Manifest V3 extensions with a preserved identity. Their permissions apply inside Perry’s browser.</InfoTip>}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{source?.[key] ?? 0}</span><Switch aria-labelledby={`browser-import-${key}`} checked={choices[key]} disabled={busy || !source?.[key]} onCheckedChange={checked => { setChoices(value => ({ ...value, [key]: checked })); setConfirmed(false); }} />
      </label>)}</div>
      <label className="flex items-start gap-2 text-xs text-muted-foreground"><Checkbox className="mt-0.5" checked={confirmed} disabled={busy} onCheckedChange={checked => setConfirmed(checked === true)} /><span>Replace selected data in Perry and allow Windows approval.<InfoTip>Protected credentials may require administrator approval. Your source profile stays unchanged.</InfoTip></span></label>
      {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
      {state?.state !== "paused" && <p className="text-xs text-muted-foreground">Open Perry’s browser and take over first.</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={busy || loading || !profile || !confirmed || state?.state !== "paused" || !Object.entries(choices).some(([key, checked]) => checked && source?.[key as keyof NativeImportChoices])} onClick={() => void importData()}>{busy ? "Importing…" : "Import"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
