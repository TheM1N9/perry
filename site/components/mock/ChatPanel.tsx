import type { ReactNode } from "react";
import { PerryAvatar } from "./PerryAvatar";

/** Telegram's date and notice pill. */
export function ServicePill({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`tg-service mx-auto w-fit shrink-0 rounded-full px-2.5 py-0.5 text-center text-[12.5px] font-medium ${className}`}>{children}</p>;
}

/** A Telegram chat as the desktop app shows it, for the chapters. */
export function ChatPanel({ children, className = "", day = "Today" }: { children: ReactNode; className?: string; day?: string }) {
  return (
    <div className={`tg-wallpaper flex flex-col overflow-hidden rounded-[18px] border border-white/10 shadow-[0_30px_80px_-30px_rgb(0_0_0/0.9)] ${className}`}>
      <div className="flex shrink-0 items-center gap-3 border-b border-black/40 bg-tg-head/95 px-4 py-2.5 backdrop-blur">
        <PerryAvatar className="size-9" />
        <div className="leading-tight">
          <p className="text-[14.5px] font-semibold text-white">Perry</p>
          <p className="text-[12.5px] text-tg-meta">bot</p>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-1.5 overflow-hidden px-3 pb-3 pt-2">
        {day ? <ServicePill className="mb-1">{day}</ServicePill> : null}
        {children}
      </div>
      <div aria-hidden className="flex shrink-0 items-center gap-3 border-t border-black/40 bg-tg-head/95 px-4 py-2.5 text-[14px] text-tg-meta">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M21 11.5 12.6 19.9a5.4 5.4 0 0 1-7.6-7.6l8.5-8.5a3.6 3.6 0 0 1 5.1 5.1l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8" strokeLinecap="round" />
        </svg>
        <span className="flex-1">Write a message…</span>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
        </svg>
      </div>
    </div>
  );
}
