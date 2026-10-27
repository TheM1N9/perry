"use client";

import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A line of what the chat is doing now, for the end of the timeline. */
export type NowLine = {
  id: string;
  icon: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  /** Inline actions, after a dot: small text buttons (NowAction). */
  actions?: ReactNode;
  /** Something going on, its title shimmering, as a reply's step does. */
  live?: boolean;
  /** Something that needs the owner, said as it appears. Others are not live regions: the chat says its state once (ChatAnnouncer, and the reset wait's own line). */
  announce?: boolean;
  /** For the end-to-end checks: which line it is. */
  data?: Record<`data-${string}`, string | boolean>;
};

/** An action on a line: text-sized, with a finger-sized hit area on touch screens. */
export function NowAction({ className, ...props }: ComponentProps<"button">) {
  return (
    <button type="button" {...props}
      className={cn("relative rounded-sm font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-x-1.5 pointer-coarse:after:-inset-y-3.5", className)} />
  );
}

/**
 * What the chat is doing now, after its last reply and before what is
 * queued: a reply held until its engine's limit resets, a computer that
 * stopped answering, the context being compacted. One muted line each: an
 * icon, the title, a detail and actions. After T3 Code's ThreadNow.
 */
export function ThreadNow({ lines }: { lines: NowLine[] }) {
  if (!lines.length) return null;
  return (
    <div className="flex flex-col gap-1" data-thread-now>
      {lines.map((line) => (
        <div key={line.id} role={line.announce ? "alert" : undefined} {...line.data}
          className="flex w-full min-w-0 items-center gap-1.5 px-1 text-xs text-muted-foreground transition-opacity duration-150 starting:opacity-0 motion-reduce:transition-none [&_svg]:size-3.5 [&_svg]:shrink-0">
          <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center">{line.icon}</span>
          {/* Title and detail give way before the actions, so Stop stays in reach; the whole of it is in the title on hover. */}
          <span className="min-w-0 truncate" title={typeof line.title === "string" ? [line.title, typeof line.detail === "string" ? line.detail : ""].filter(Boolean).join(" · ") : undefined}>
            <span className={cn(line.live && "shimmer motion-reduce:shimmer-none")}>{line.title}</span>
            {line.detail && <> <span aria-hidden>·</span> {line.detail}</>}
          </span>
          {line.actions && <>
            <span aria-hidden>·</span>
            <span className="flex shrink-0 items-center gap-1.5">{line.actions}</span>
          </>}
        </div>
      ))}
    </div>
  );
}
