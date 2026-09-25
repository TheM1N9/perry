import type { ReactNode } from "react";
import { PerryAvatar } from "./PerryAvatar";

/** A Telegram chat without the phone around it, for the chapters. */
export function ChatPanel({ children, className = "", title = "Perry" }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <div className={`tg-wallpaper lit-border flex flex-col overflow-hidden rounded-[22px] ${className}`}>
      <div className="flex shrink-0 items-center gap-3 bg-tg-head px-4 py-3">
        <PerryAvatar className="size-8" />
        <div className="leading-tight">
          <p className="text-[14.5px] font-semibold text-white">{title}</p>
          <p className="text-[12px] text-tg-meta">bot</p>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-1.5 overflow-hidden p-3">{children}</div>
    </div>
  );
}
