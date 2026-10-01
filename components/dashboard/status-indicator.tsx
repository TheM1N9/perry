"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { ChatStatus } from "@/convex/dashboard";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** How long a chat that just finished shows its green dot, when its reply is already seen. */
const DONE_MS = 4_000;

/** True for a few seconds after the chat goes from working to finished. */
function useJustFinished(status: ChatStatus) {
  const previous = useRef(status);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (was === "running" && status === "idle") {
      setDone(true);
      const timer = window.setTimeout(() => setDone(false), DONE_MS);
      return () => window.clearTimeout(timer);
    }
    if (status !== "idle") setDone(false);
  }, [status]);
  return done;
}

/** What a chat's dot says, for the steady states; "Done" is only for the moment one finishes. */
export function statusLabel(status: ChatStatus, unseen?: boolean): string | null {
  return status === "running" ? "Working" : status === "needs-approval" ? "Waiting for your approval"
    : status === "error" ? "The last reply failed" : unseen ? "Reply ready" : null;
}

/** A dot, named for screen readers, and in words on hover. Its tip is data-solid for the pet's window, which lists chats too. */
function Dot({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} aria-label={label} />
      <TooltipContent data-solid>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * What a chat is doing: a spinner while it works, a pulsing amber dot while
 * it waits on you, a red dot when the last reply failed, and a green dot
 * once a reply is ready. The green dot stays until you read the reply, or for
 * a moment when you were already watching it land.
 */
export function StatusIndicator({ status, unseen, className }: { status: ChatStatus; unseen?: boolean; className?: string }) {
  const done = useJustFinished(status);
  const box = cn("relative flex size-4 shrink-0 items-center justify-center", className);
  if (status === "running") {
    return (
      <Dot label="Working">
        <span role="img" data-status="running" className={box}>
          <span className="size-3 rounded-full border-2 border-primary/25 border-t-primary motion-safe:animate-spin motion-reduce:animate-pulse" />
        </span>
      </Dot>
    );
  }
  if (status === "needs-approval") {
    return (
      <Dot label="Waiting for your approval">
        <span role="img" data-status="needs-approval" className={box}>
          <span className="absolute size-2 rounded-full bg-warning opacity-60 motion-safe:animate-ping" />
          <span className="relative size-2 rounded-full bg-warning" />
        </span>
      </Dot>
    );
  }
  if (status === "error") {
    return (
      <Dot label="The last reply failed">
        <span role="img" data-status="error" className={box}>
          <span className="size-2 rounded-full bg-destructive" />
        </span>
      </Dot>
    );
  }
  if (!unseen && !done) return null;
  const label = unseen ? "Reply ready" : "Done";
  return (
    <Dot label={label}>
      <span role="img" data-status={unseen ? "unseen" : "done"} className={cn(box, "animate-in fade-in zoom-in-50 duration-300 motion-reduce:animate-none")}>
        <span className="size-2 rounded-full bg-success" />
      </span>
    </Dot>
  );
}
