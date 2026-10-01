"use client";

import { ArrowUpCircleIcon, ChevronRightIcon } from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";
import { useAction, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { UpdateView } from "@/convex/updates";
import { ago, errorText, plural, useNow } from "@/lib/format";
import { useDashboardKey } from "@/lib/session";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { ActionButton, ListSkeleton, Section, StatusBadge } from "./common";

/**
 * Perry's own updates (convex/updates.ts), wherever they show: a note in the
 * sidebar while one is waiting, the Updates section of Settings, and the pet.
 * Updating is one click; Perry does it himself (`perry run`), restarting as he
 * does, and this page reconnects once he is back.
 */

/** An update there is to do from here: found, and nothing in the way. */
export const updateReady = (view: UpdateView | undefined): boolean =>
  Boolean(view && view.supervised && view.behind > 0 && !view.problem && view.state === "idle");

const short = (sha?: string) => sha?.slice(0, 7) ?? "?";

/** The status, and the click that updates: it says what happens next, as a sentence for a toast or a bubble. */
export function useUpdates() {
  const key = useDashboardKey();
  const view = useQuery(api.updates.status, { key });
  const request = useMutation(api.updates.update);
  const update = useCallback(async (): Promise<string> => {
    const { waitingFor } = await request({ key });
    return waitingFor ? `Perry is busy with ${waitingFor}; he updates as soon as he's done.` : "Updating. Perry restarts in a few minutes.";
  }, [key, request]);
  return { view, update };
}

/** In the sidebar, above the computer: there is an update, and the button that does it. */
export function UpdateNotice() {
  const { view, update } = useUpdates();
  if (!view || !(updateReady(view) || view.state !== "idle")) return null;
  const busy = view.state !== "idle";
  const label = view.state === "updating" ? "Updating…" : view.state === "waiting" ? "Update waiting" : "Update available";
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        {/* Folded to icons, the sidebar has room for the icon alone. */}
        <SidebarMenuButton tooltip={label} className="hidden group-data-[collapsible=icon]:flex" disabled={busy}
          onClick={() => void update().then((text) => toast.success(text), (cause) => toast.error(errorText(cause)))}>
          {busy ? <Spinner /> : <ArrowUpCircleIcon className="text-primary" />}
          <span>{label}</span>
        </SidebarMenuButton>
        <div role="status" className="rounded-lg border bg-background px-3 py-2.5 group-data-[collapsible=icon]:hidden">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            {busy ? <Spinner className="size-3.5" /> : <ArrowUpCircleIcon className="size-4 text-primary" aria-hidden />}{label}
          </p>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
            {view.state === "updating" ? "Perry restarts in a few minutes."
              : view.state === "waiting" ? `Once Perry is done with ${view.busy ?? "what he's doing"}.`
                : `${plural(view.behind, "change")} · ${view.latest?.title ?? ""}`}
          </p>
          {!busy && (
            <ActionButton size="xs" className="mt-2" action={async () => toast.success(await update())}>Update</ActionButton>
          )}
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** Settings → General: where Perry's version stands, the night's update on or off, and how the last one went. */
export function Updates() {
  const key = useDashboardKey();
  const { view, update } = useUpdates();
  const setAuto = useMutation(api.updates.setAuto).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.updates.status, { key: args.key });
    if (current) store.setQuery(api.updates.status, { key: args.key }, { ...current, auto: args.on });
  });
  const check = useAction(api.updates.check);
  const now = useNow();

  return (
    <Section title="Updates" description="Perry looks for a new version once a day. Around 4:00 at night, your time, he updates himself if he isn't busy.">
      {view === undefined ? <ListSkeleton rows={1} /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start gap-3 rounded-xl border bg-card p-4" data-update-state={view.state}>
            <div className="min-w-0 flex-1">
              <Headline view={view} />
              <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{detail(view, now)}</p>
            </div>
            {updateReady(view)
              ? <ActionButton size="sm" action={async () => toast.success(await update())}>Update</ActionButton>
              : view.state === "idle" && (
                <ActionButton variant="outline" size="sm" action={() => check({ key })}>Check now</ActionButton>
              )}
          </div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <Switch checked={view.auto} aria-label="Update at night"
              onCheckedChange={(on) => void setAuto({ key, on }).then(
                () => toast.success(on ? "Perry updates himself at night." : "Perry won't update himself; you'll see when there's an update."),
                (cause) => toast.error(errorText(cause)))} />
            Update on his own at night
          </label>
          {view.last && <LastUpdate last={view.last} now={now} />}
        </div>
      )}
    </Section>
  );
}

function Headline({ view }: { view: UpdateView }) {
  if (view.state === "updating") return <h3 className="flex items-center gap-2 font-medium"><Spinner className="size-4" />Updating…</h3>;
  if (view.state === "waiting") return <h3 className="flex items-center gap-2 font-medium"><Spinner className="size-4" />Update waiting</h3>;
  if (view.behind > 0) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{view.problem ? "An update Perry can't do himself" : "Update available"}</h3>
        <StatusBadge tone={view.problem ? "warning" : "info"}>{plural(view.behind, "change")}</StatusBadge>
      </div>
    );
  }
  return <h3 className="font-medium">{view.problem ? "Can't check for updates" : view.checkedAt ? "Up to date" : "Not checked yet"}</h3>;
}

function detail(view: UpdateView, now: number): string {
  if (view.state === "updating") return "Perry is stopping, updating and starting again, in a few minutes. This page reconnects on its own.";
  if (view.state === "waiting") return `He updates as soon as he's done with ${view.busy ?? "what he's doing"}.`;
  const newest = view.latest ? `The newest: “${view.latest.title}”. ` : "";
  if (view.problem) return `${newest}${view.problem}`;
  if (!view.supervised) return `${newest}Perry updates himself when he runs in the background: start him with perry start. Until then, perry update in his folder does it.`;
  if (view.behind > 0) return newest.trim();
  return view.checkedAt ? `Checked ${ago(view.checkedAt, now)}.` : "He looks for one a minute or so after he starts.";
}

function LastUpdate({ last, now }: { last: NonNullable<UpdateView["last"]>; now: number }) {
  const at = ago(last.at, now);
  const when = `${at === "now" ? "just now" : at}${last.by === "nightly" ? ", overnight" : ""}`;
  return (
    <div className="text-sm" data-last-update={last.ok ? "ok" : "failed"}>
      {last.ok ? (
        <p className="text-muted-foreground">
          {last.from === last.to ? `Last update ${when}: already up to date.` : `Updated ${when}, from ${short(last.from)} to ${short(last.to)}${last.title ? `: “${last.title}”` : ""}.`}
        </p>
      ) : (
        <p className="text-pretty text-destructive">The update {when} didn&apos;t work. {last.error}</p>
      )}
      {!last.ok && last.log && (
        <Collapsible className="mt-2">
          <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 rounded-md text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
            <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90" aria-hidden />What it said
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ScrollArea className="mt-1.5 rounded-lg border bg-muted/40" viewportClassName="max-h-64">
              <pre className="p-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{last.log}</pre>
            </ScrollArea>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
