"use client";

import { ArrowUpIcon, ChevronRightIcon, RotateCwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useAction, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { UpdateView } from "@/convex/updates";
import { ago, errorText, useNow } from "@/lib/format";
import { useDashboardKey } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ActionButton, ListSkeleton, Section } from "./common";
import { useVersionNotice } from "./version-notice";

const RELOAD = "perry.update.reload";

export const updateReady = (view: UpdateView | undefined): boolean =>
  Boolean(view && view.supervised && view.behind > 0 && !view.problem && (view.state === "idle" || view.state === "ready"));

/** Installation is server-owned. The marker identifies the tab to reload afterward. */
export function useUpdates() {
  const key = useDashboardKey();
  const view = useQuery(api.updates.status, { key });
  const request = useMutation(api.updates.update);
  const fetchUpdate = useAction(api.updates.download);
  const reloadRequired = useVersionNotice(view?.uiVersion);
  const downloading = useRef(false);
  const installing = useRef(false);

  useEffect(() => {
    let pending: { sha: string; previous?: string } | null = null;
    try { pending = JSON.parse(sessionStorage.getItem(RELOAD) ?? "null"); } catch { sessionStorage.removeItem(RELOAD); }
    if (!pending) return;
    if (reloadRequired) { sessionStorage.removeItem(RELOAD); window.location.reload(); return; }
    if (!view?.last || view.last.id === pending.previous) return;
    if (!view.last.ok) { sessionStorage.removeItem(RELOAD); return; }
    if (view.last.to !== pending.sha) return;
    sessionStorage.removeItem(RELOAD);
    window.location.reload();
  }, [view?.last, reloadRequired]);

  const download = useCallback(async (): Promise<string> => {
    if (downloading.current) return "Downloading the update…";
    downloading.current = true;
    try {
      const result = await fetchUpdate({ key });
      return result.ready ? "Update downloaded. Reload when you’re ready to install." : "Update check complete.";
    } finally { downloading.current = false; }
  }, [key, fetchUpdate]);

  const install = useCallback(async (): Promise<string> => {
    if (reloadRequired) { window.location.reload(); return "Reloading…"; }
    if (installing.current) return "Installing the update…";
    const sha = view?.downloaded?.sha;
    if (!sha) throw new Error("Download the update first.");
    installing.current = true;
    try {
      sessionStorage.setItem(RELOAD, JSON.stringify({ sha, previous: view?.last?.id }));
      const { waitingFor } = await request({ key, expectedSha: sha });
      return waitingFor ? "Perry will install the update when the current work finishes." : "Installing the update. This page will reload when it’s ready.";
    } catch (error) {
      sessionStorage.removeItem(RELOAD);
      throw error;
    } finally { installing.current = false; }
  }, [key, request, reloadRequired, view?.downloaded?.sha, view?.last?.id]);

  const update = view?.state === "ready" || reloadRequired ? install : download;
  return { view, update, download, install, reloadRequired };
}

/** One quiet control beside Perry’s name, with no sidebar banner. */
export function UpdateControl() {
  const { view, download, install, reloadRequired } = useUpdates();
  const key = useDashboardKey();
  const check = useAction(api.updates.check);
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const ready = view?.state === "ready" || reloadRequired;
  const busy = pending || (!reloadRequired && (view?.state === "downloading" || view?.state === "waiting" || view?.state === "updating"));
  const available = Boolean(view && view.behind > 0);
  const blocked = available && (!view?.supervised || Boolean(view?.problem));
  const label = reloadRequired ? "Reload Perry" : view?.state === "downloading" ? "Downloading update" : view?.state === "waiting" ? "Waiting to install update"
    : view?.state === "updating" ? "Installing update" : ready ? "Reload to install update" : blocked ? "Review update" : available ? "Download update" : "Check for updates";
  const activate = async () => {
    if (inFlight.current || busy) return;
    if (!ready && blocked) { router.push("/settings/general"); return; }
    inFlight.current = true;
    setPending(true);
    try {
      if (ready) toast.success(await install());
      else if (available) toast.success(await download());
      else { await check({ key }); toast.info("Update check complete."); }
    } catch { toast.error("Couldn’t update Perry. Try again in Settings."); }
    finally { inFlight.current = false; setPending(false); }
  };
  return <Tooltip>
    <TooltipTrigger render={<Button type="button" variant="ghost" size={ready ? "sm" : "icon"} disabled={!view || busy} aria-label={label}
      data-update-control data-update-state={view?.state ?? "loading"} aria-busy={busy} onClick={() => void activate()}
      className={cn("relative h-9 shrink-0 touch-manipulation rounded-full border border-border/60 bg-transparent text-muted-foreground before:absolute before:-inset-1",
        ready ? "gap-1.5 px-2.5 group-data-[collapsible=icon]:size-9 group-data-[collapsible=icon]:p-0" : "size-9",
        available && !busy && !ready && "text-destructive hover:text-destructive")} />}>
      {busy ? <Spinner className="size-4" /> : ready ? <RotateCwIcon className="size-4" /> : <ArrowUpIcon className="size-4" />}
      {ready && <span className="group-data-[collapsible=icon]:hidden">Reload</span>}
    </TooltipTrigger>
    <TooltipContent side="top">{label}</TooltipContent>
  </Tooltip>;
}

export function Updates() {
  const key = useDashboardKey();
  const { view, update, reloadRequired } = useUpdates();
  const setAuto = useMutation(api.updates.setAuto).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.updates.status, { key: args.key });
    if (current) store.setQuery(api.updates.status, { key: args.key }, { ...current, auto: args.on });
  });
  const check = useAction(api.updates.check);
  const now = useNow();
  const busy = !reloadRequired && (view?.state === "downloading" || view?.state === "waiting" || view?.state === "updating");
  return <Section title="Updates" tip="Updates download while you work. Choose Reload to install when you’re ready.">
    {view === undefined ? <ListSkeleton rows={1} /> : <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3" data-update-state={view.state}>
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-2 text-sm font-medium">{busy && <Spinner className="size-4" />}{headline(view, reloadRequired)}</h3>
          <p className="mt-1 text-sm text-pretty text-muted-foreground">{detail(view, now, reloadRequired)}</p>
        </div>
        {reloadRequired || updateReady(view)
          ? <ActionButton size="sm" className="min-h-11" action={async () => toast.success(await update())}>{reloadRequired || view.state === "ready" ? "Reload to install" : "Download update"}</ActionButton>
          : !busy && <ActionButton variant="outline" size="sm" className="min-h-11" action={() => check({ key })}>Check for updates</ActionButton>}
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <Switch checked={view.auto} aria-label="Install updates overnight" onCheckedChange={(on) => void setAuto({ key, on }).catch((cause) => toast.error(errorText(cause)))} />
        Install updates overnight
      </label>
      {view.last && <LastUpdate last={view.last} now={now} />}
    </div>}
  </Section>;
}

function headline(view: UpdateView, reloadRequired: boolean) {
  if (view.state === "updating") return "Installing update…";
  if (view.state === "waiting") return "Waiting to install";
  if (view.state === "downloading") return "Downloading update…";
  if (view.state === "ready" || reloadRequired) return "Ready to install";
  if (view.behind > 0) return "Update available";
  return view.problem ? "Couldn’t check for updates" : view.checkedAt ? "You’re up to date" : "Check for a new version";
}

function detail(view: UpdateView, now: number, reloadRequired: boolean): string {
  if (view.state === "updating") return "Perry will be back shortly. This page will reload when the update is installed.";
  if (view.state === "waiting") return "The update will install when the current work finishes.";
  if (view.state === "downloading") return "You can keep using Perry while it downloads.";
  if (reloadRequired) return "Reload this page to use the updated Perry.";
  if (view.problem) {
    if (/changes.*committed|commit or stash/i.test(view.problem)) return "Save your local changes before updating Perry.";
    if (/commits of its own|following a branch|git checkout|git isn't working/i.test(view.problem)) return "This copy of Perry needs a manual update.";
    return "Perry couldn’t reach the update service. Try again.";
  }
  if (!view.supervised) return "Start Perry in the background to install updates here.";
  if (view.state === "ready") return "The download is ready. Reload when you want to install it.";
  if (view.behind > 0) return "Download the latest version, then reload to install.";
  return view.checkedAt ? `Checked ${ago(view.checkedAt, now)}.` : "";
}

function LastUpdate({ last, now }: { last: NonNullable<UpdateView["last"]>; now: number }) {
  return <div className="text-sm" data-last-update={last.ok ? "ok" : "failed"}>
    <p className={last.ok ? "text-muted-foreground" : "text-destructive"}>{last.ok ? `Last updated ${ago(last.at, now)}.` : "The update couldn’t be installed. Try again."}</p>
    {!last.ok && (last.error || last.log) && <Collapsible className="mt-1">
      <CollapsibleTrigger className="group flex min-h-11 touch-manipulation cursor-pointer items-center gap-1 rounded-md text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none" aria-hidden />Technical details
      </CollapsibleTrigger>
      <CollapsibleContent><ScrollArea className="border-l border-border" viewportClassName="max-h-64">
        <pre className="px-3 py-1 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{[last.error, last.log].filter(Boolean).join("\n\n")}</pre>
      </ScrollArea></CollapsibleContent>
    </Collapsible>}
  </div>;
}
