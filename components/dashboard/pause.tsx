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
      {paused ? <PlayIcon /> : <PauseIcon />}{paused ? "Resume Perry" : "Pause Perry"}
    </DropdownMenuItem>
  );
}
