import type { ReactNode } from "react";
import { ServicePill } from "./ChatPanel";
import { PerryAvatar } from "./PerryAvatar";

/** A phone showing Perry's chat in Telegram's dark theme. Messages sit at the bottom, as in the app. */
export function Phone({ children, className = "", status = "bot" }: { children: ReactNode; className?: string; status?: string }) {
  return (
    <div className={`relative rounded-[48px] bg-[#030405] p-[9px] shadow-[0_0_0_1px_rgb(255_255_255/0.12),0_40px_120px_-20px_rgb(0_0_0/0.9)] ${className}`}>
      <div className="tg-wallpaper relative flex h-full flex-col overflow-hidden rounded-[40px]">
        <div className="flex h-11 shrink-0 items-center justify-between px-7 pt-1 text-[13px] font-semibold text-white">
          <span>9:41</span>
          <span aria-hidden className="absolute left-1/2 top-2.5 h-[26px] w-[92px] -translate-x-1/2 rounded-full bg-black" />
          <span aria-hidden className="flex items-center gap-1.5">
            <svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor">
              <rect x="0" y="7" width="3" height="4" rx="1" />
              <rect x="4.5" y="5" width="3" height="6" rx="1" />
              <rect x="9" y="2.5" width="3" height="8.5" rx="1" />
              <rect x="13.5" y="0" width="3" height="11" rx="1" />
            </svg>
            <svg width="25" height="12" viewBox="0 0 25 12" fill="none">
              <rect x="0.5" y="0.5" width="21" height="11" rx="3.5" stroke="currentColor" opacity=".4" />
              <rect x="2" y="2" width="16" height="8" rx="2" fill="currentColor" />
              <rect x="23" y="4" width="1.5" height="4" rx=".75" fill="currentColor" opacity=".4" />
            </svg>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3 border-b border-black/40 bg-tg-head/95 px-4 py-2.5 backdrop-blur">
          <svg aria-hidden width="10" height="17" viewBox="0 0 10 17" className="text-accent">
            <path d="M8.5 1.5 2 8.5l6.5 7" stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <PerryAvatar className="size-9" />
          <div className="leading-tight">
            <p className="text-[15px] font-semibold text-white">Perry</p>
            <p className="text-[12.5px] text-tg-meta">{status}</p>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-1.5 overflow-hidden px-2.5 pb-3 pt-2">
          <ServicePill className="mb-1">Today</ServicePill>
          {children}
        </div>
        <div aria-hidden className="flex shrink-0 items-center gap-2 border-t border-black/40 bg-tg-head/95 px-3 py-2.5 text-tg-meta">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M21 11.5 12.6 19.9a5.4 5.4 0 0 1-7.6-7.6l8.5-8.5a3.6 3.6 0 0 1 5.1 5.1l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8" strokeLinecap="round" />
          </svg>
          <span className="flex-1 rounded-full bg-tg-bg px-4 py-1.5 text-[14px]">Message</span>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <rect x="9" y="3" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
          </svg>
        </div>
        <div aria-hidden className="mx-auto mb-2 mt-1 h-[5px] w-32 shrink-0 rounded-full bg-white/80" />
      </div>
    </div>
  );
}
