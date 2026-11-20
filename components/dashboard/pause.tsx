"use client";

import { CalendarClockIcon, CirclePauseIcon, PauseIcon, PlayIcon } from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorText } from "@/lib/format";
import { useDashboardKey } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { ActionButton } from "./common";

/**
 * Pause Perry (convex/pause.ts), wherever it shows: a note in the sidebar
 * while he is paused, and the schedules he missed once he is back, each to
 * run or let go; the switch in the account menu; /pause and /resume in the
 * composer. The pet has its own (components/pet/pet.tsx).
 */

export const PAUSED_TOAST = "Paused. Nothing runs until you resume.";

/** Where pausing stands, and the switch. */
export function usePause(from: "web" | "pet" = "web") {
  const key = useDashboardKey();
  const view = useQuery(api.pause.status, { key });
  const set = useMutation(api.pause.set);
  const setPaused = useCallback((paused: boolean) => set({ key, paused, from }), [key, set, from]);
  return { view, paused: Boolean(view?.paused), setPaused };
}

/** Global scope is explicit; stopping one reply stays beside that reply. */
export function PauseControl({ active }: { active: boolean }) {
  const { view, paused, setPaused } = usePause();
  if (!active || paused) return null;
  return <SidebarMenu data-global-pause><SidebarMenuItem>
    <ActionButton variant="outline" render={<SidebarMenuButton tooltip="Pause all work" />} className="h-8 justify-start gap-2 rounded-md px-2 font-normal group-data-[collapsible=icon]:justify-center" aria-label="Pause all work" disabled={!view}
      confirm={PAUSE_CONFIRM}
      action={() => setPaused(true)} success={PAUSED_TOAST}>
      <PauseIcon /><span className="group-data-[collapsible=icon]:hidden">Pause all work</span>
    </ActionButton>
  </SidebarMenuItem></SidebarMenu>;
}

/** The confirm every "Pause all work" asks first. */
const PAUSE_CONFIRM = { title: "Pause all work?", body: "This stops current replies and tasks, and prevents schedules, watches and new replies from starting until you resume. Completed actions are not undone.", label: "Pause all work" };

/**
 * The same switch in the Board's header, where the work it stops is listed: "Pause all" while something runs,
 * "Resume" while Perry is paused, nothing otherwise. `compact`: a shorter word, for a narrow header; never the icon
 * alone, which a phone would read as the needs-you glyph.
 */
export function BoardPause({ active, compact = false }: { active: boolean; compact?: boolean }) {
  const { view, paused, setPaused } = usePause();
  if (!view || (!paused && !active)) return null;
  if (paused) {
    return (
      <ActionButton variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-[12px]" aria-label="Resume Perry" data-pause="paused"
        action={() => setPaused(false)} success="Perry is back on.">
        <PlayIcon />resume
      </ActionButton>
    );
  }
  return (
    <ActionButton variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-[12px] text-muted-foreground" aria-label="Pause all work" data-pause="running"
      confirm={PAUSE_CONFIRM} action={() => setPaused(true)} success={PAUSED_TOAST}>
      <PauseIcon />{compact ? "pause" : "pause all work"}
    </ActionButton>
  );
}

/** In the sidebar, above the computer: paused, with Resume; back on, what was missed. */
export function PauseNotice() {
  const key = useDashboardKey();
  const { view, paused, setPaused } = usePause();
  const runMissed = useMutation(api.pause.runMissedNow);
  const skip = useMutation(api.pause.skip);
  if (!view || (!paused && !view.missed.length)) return null;
  const resume = () => void setPaused(false).then(() => toast.success("Perry is back on."), (cause) => toast.error(errorText(cause)));
  const run = (id: Id<"jobs">, name: string) => void runMissed({ key, id }).then(() => toast.success(`Running ${name}.`), (cause) => toast.error(errorText(cause)));
  const letGo = (id?: Id<"jobs">) => void skip({ key, ...(id ? { id } : {}) }).catch((cause) => toast.error(errorText(cause)));
  const label = paused ? "Perry is paused" : "Missed while paused";
  return (
    <SidebarMenu data-pause-notice={paused ? "paused" : "missed"}>
      <SidebarMenuItem>
        {/* Folded to icons, the sidebar has room for the icon alone. */}
        <SidebarMenuButton tooltip={paused ? `${label} · Resume` : label} className="hidden group-data-[collapsible=icon]:flex"
          onClick={paused ? resume : undefined}>
          {paused ? <CirclePauseIcon className="text-warning" /> : <CalendarClockIcon className="text-warning" />}
          <span>{label}</span>
        </SidebarMenuButton>
        <div role="status" className="px-2 py-1.5 group-data-[collapsible=icon]:hidden">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            {paused ? <CirclePauseIcon className="size-4 text-warning" aria-hidden /> : <CalendarClockIcon className="size-4 text-warning" aria-hidden />}{label}
          </p>
          {paused ? (
            <>
              <p className="mt-0.5 text-xs text-muted-foreground">Nothing runs until you resume.</p>
              <Button variant="link" size="xs" className="mt-0.5 h-auto px-0" onClick={resume}>Resume</Button>
            </>
          ) : (
            <>
              <ul className="mt-1 grid gap-1">
                {view.missed.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 text-xs" data-missed={item.name}>
                    <span className="min-w-0 flex-1 truncate">
                      {item.name}
                      <span className="text-muted-foreground"> · {item.when}{item.runs > 1 ? ` ×${item.runs}` : ""}</span>
                    </span>
                    <Button variant="link" size="xs" className="h-auto px-0" onClick={() => run(item.id, item.name)}>Run</Button>
                    <Button variant="link" size="xs" className="h-auto px-0 text-muted-foreground" onClick={() => letGo(item.id)}>Skip</Button>
                  </li>
                ))}
              </ul>
              {view.missed.length > 1 && (
                <Button variant="link" size="xs" className="mt-0.5 h-auto px-0 text-muted-foreground" onClick={() => letGo()}>Skip all</Button>
              )}
            </>
          )}
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** The switch, in the account menu. */
export function PauseMenuItem() {
  const { view, paused, setPaused } = usePause();
  const flip = () => void setPaused(!paused).then(
    () => toast.success(paused ? "Perry is back on." : PAUSED_TOAST),
    (cause) => toast.error(errorText(cause)),
  );
  return (
    <DropdownMenuItem disabled={view === undefined} onClick={flip}>
      {paused ? <PlayIcon /> : <PauseIcon />}{paused ? "Resume Perry" : "Pause all work"}
    </DropdownMenuItem>
  );
}
