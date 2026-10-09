"use client";

import Link from "next/link";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { SHORTCUT_IDS, SHORTCUTS, describe, fromEvent, holdProblem, keysOf, problemWith, type ShortcutId } from "@/convex/lib/shortcuts";
import { errorText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useIsMac } from "@/hooks/use-shortcuts";
import { Button } from "@/components/ui/button";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { List, ListSkeleton, Section } from "./common";

/**
 * Settings → Desktop pet → Keyboard shortcuts: each one, and the keys it is
 * on. Click one and press the keys you want; Esc leaves it as it was. Talk to
 * Perry and Show Perry the screen are the desktop pet's, and work anywhere on
 * this computer; each says whether the pet could take the keys, since another
 * app may already have them.
 */
export function Shortcuts() {
  const { dashboardKey } = useSession();
  const data = useQuery(api.dashboard.getShortcuts, { key: dashboardKey });
  const mac = useIsMac();
  const [recording, setRecording] = useState<ShortcutId | null>(null);

  return (
    <Section id="shortcuts" title="Keyboard shortcuts" description="Click one, then press the new keys.">
      {data === undefined ? <ListSkeleton rows={4} /> : (
        <List label="Keyboard shortcuts">
          {SHORTCUT_IDS.map((id) => (
            <li key={id} className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{SHORTCUTS[id].label}</p>
                {SHORTCUTS[id].description && <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{SHORTCUTS[id].description}</p>}
                {SHORTCUTS[id].global && <PetStatus pet={{ running: data.pet.running, ...data.pet.keys[id] }} wanted={data.shortcuts[id]} mac={mac} />}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {data.shortcuts[id] !== SHORTCUTS[id].default && recording !== id && <ResetButton id={id} />}
                <Recorder id={id} value={data.shortcuts[id]} mac={mac} recording={recording === id}
                  onRecording={(on) => setRecording(on ? id : null)} />
              </div>
            </li>
          ))}
        </List>
      )}
    </Section>
  );
}

function Keys({ accelerator, mac }: { accelerator: string; mac: boolean }) {
  return <KbdGroup>{keysOf(accelerator, mac).map((key, index) => <Kbd key={index} className="h-6 min-w-6 px-1.5">{key}</Kbd>)}</KbdGroup>;
}

/** The keys, as a button: click, then press the new ones. */
function Recorder({ id, value, mac, recording, onRecording }: {
  id: ShortcutId; value: string; mac: boolean; recording: boolean; onRecording: (on: boolean) => void;
}) {
  const { dashboardKey } = useSession();
  const save = useMutation(api.dashboard.setShortcut);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    if (!recording) return;
    setProblem("");
    // First in line for every key, so the dashboard's own shortcuts do not fire while keys are being picked.
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) return onRecording(false);
      const accelerator = fromEvent(event, mac);
      // Only modifiers so far: wait for the key that goes with them.
      if (!accelerator) return;
      const why = problemWith(accelerator);
      if (why) return setProblem(why);
      onRecording(false);
      if (accelerator === value) return;
      void save({ key: dashboardKey, id, accelerator }).then(
        () => toast.success(`${SHORTCUTS[id].label} is on ${keysOf(accelerator, mac).join(mac ? "" : "+")} now.`),
        (cause) => toast.error(errorText(cause)),
      );
    };
    const onBlur = () => onRecording(false);
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, { capture: true });
      window.removeEventListener("blur", onBlur);
    };
  }, [recording, mac, value, id, dashboardKey, save, onRecording]);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" variant="outline" size="lg" onClick={() => onRecording(!recording)} aria-label={`${SHORTCUTS[id].label}: ${keysOf(value, mac).join(" ")}. Click to change.`}
        aria-pressed={recording} className={cn("min-w-36 px-3", recording && "border-ring ring-3 ring-ring/50")}>
        {recording ? <span className="font-normal text-muted-foreground">Press keys…</span> : <Keys accelerator={value} mac={mac} />}
      </Button>
      {recording && problem && <p role="alert" className="max-w-60 text-right text-xs text-destructive">{problem}</p>}
    </div>
  );
}

function ResetButton({ id }: { id: ShortcutId }) {
  const { dashboardKey } = useSession();
  const save = useMutation(api.dashboard.setShortcut);
  return (
    <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void save({ key: dashboardKey, id, accelerator: null }).catch((cause) => toast.error(errorText(cause)))}>
      Reset
    </Button>
  );
}

/** Whether the desktop pet has a shortcut's keys: working (for Talk, maybe only by tapping), taken by another app, catching up, or not running. */
function PetStatus({ pet, wanted, mac }: { pet: { running: boolean; hotkey?: string; error?: string; hold?: string }; wanted: string; mac: boolean }) {
  if (!pet.running) {
    return (
      <p className="mt-1.5 text-sm text-muted-foreground">
        The desktop pet isn't on. <Link href="/settings/desktop-pet" className="link">Turn him on above</Link>.
      </p>
    );
  }
  if (pet.error) {
    const still = pet.hotkey ? ` He's still on ${describe(pet.hotkey, mac)}.` : "";
    return (
      <p className="mt-1.5 flex items-start gap-1.5 text-sm text-pretty text-warning">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
        {pet.error === "restart" ? "Restart the desktop pet for this one: Quit from his tray icon, then turn him on again."
          : <>{pet.error === "taken" ? `Another app on this computer already uses ${describe(wanted, mac)}.` : `The desktop pet can't use ${describe(wanted, mac)}.`}{still} Pick other keys.</>}
      </p>
    );
  }
  if (pet.hotkey !== wanted) return <p className="mt-1.5 text-sm text-muted-foreground">The desktop pet is changing over…</p>;
  const tapOnly = holdProblem(pet.hold);
  if (tapOnly) {
    return (
      <p className="mt-1.5 flex items-start gap-1.5 text-sm text-pretty text-warning">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
        Working in the desktop pet, by tapping: tap, speak, and tap again. {tapOnly}
      </p>
    );
  }
  return (
    <p className="mt-1.5 flex items-center gap-1.5 text-sm text-success">
      <CheckIcon className="size-4 shrink-0" />Working in the desktop pet.
    </p>
  );
}
