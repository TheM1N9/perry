"use client";

import { CheckIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { useAction, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { errorText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { PlatypusArt } from "./platypus";

/**
 * The desktop pet, from the dashboard: whether he is on the screen of the
 * computer Perry runs on, and a button to turn him on (installed the first
 * time, and started with that computer from then on) or off. While that
 * happens, the step it is on; if it fails, what it said.
 */
export function PetControl() {
  const { dashboardKey } = useSession();
  const pet = useQuery(api.pet.status, { key: dashboardKey });
  const turnOn = useAction(api.pet.turnOn);
  const turnOff = useAction(api.pet.turnOff);
  // It runs as long as setup takes, minutes the first time; the page follows it in pet.status, not in this call.
  const start = (which: typeof turnOn) => void which({ key: dashboardKey }).catch((cause) => toast.error(errorText(cause)));

  if (pet === undefined) return <div className="h-20 animate-pulse rounded-xl border bg-muted/40" />;
  const working = pet.setup?.state === "working";
  const failed = pet.setup?.state === "failed" ? pet.setup : null;

  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-4 sm:flex-row sm:items-center">
      <PlatypusArt head asleep={!pet.running && !working} hat={pet.running || working} className="size-14 shrink-0 rounded-full bg-brand-soft" />
      <div className="min-w-0 flex-1" aria-live="polite">
        {working ? (
          <p className="flex items-center gap-2 font-medium">
            <Spinner />{pet.setup?.step ?? (pet.setup?.action === "off" ? "Turning him off…" : "Getting him ready…")}
          </p>
        ) : pet.running ? (
          <p className="flex items-center gap-1.5 font-medium text-success"><CheckIcon className="size-4" />On your desktop</p>
        ) : (
          <p className="font-medium">Not on your desktop</p>
        )}
        <p className="mt-0.5 text-sm text-pretty text-muted-foreground">
          {working && pet.setup?.action === "on"
            ? `On ${pet.host}. The first time installs him (under 1 GB), a few minutes; after that he starts in seconds.`
            : pet.running
              ? `On ${pet.host}, and he starts with it. Click him for your chats, to-dos and what needs you.`
              : `He appears on ${pet.host}, the computer Perry runs on, and starts with it from then on.`}
        </p>
        {failed && !working && (
          <div role="alert" className="mt-2 flex items-start gap-1.5 text-sm text-destructive">
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <pre className="min-w-0 font-sans whitespace-pre-wrap [overflow-wrap:anywhere]">{failed.error}</pre>
          </div>
        )}
      </div>
      <div className="shrink-0">
        {pet.running
          ? <Button variant="outline" disabled={working} onClick={() => start(turnOff)}>{working && <Spinner />}Turn off</Button>
          : <Button disabled={working} onClick={() => start(turnOn)}>{working && <Spinner />}{failed ? "Try again" : "Turn on"}</Button>}
      </div>
    </div>
  );
}
