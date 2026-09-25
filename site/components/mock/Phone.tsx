"use client";

import type { ReactNode } from "react";
import { TgThemeContext, type TgTheme } from "./Chat";
import { PerryAvatar } from "./PerryAvatar";

/** A phone with Perry's Telegram chat open. Messages sit at the bottom, as in the app. */
export function Phone({
  children, className = "", theme = "day", clock = "9:41", status = "bot",
}: { children: ReactNode; className?: string; theme?: TgTheme; clock?: string; status?: string }) {
  const night = theme === "night";
  const chrome = night ? "bg-tgn-head/95 text-white" : "bg-white/95 text-black";
  const sub = night ? "text-tgn-meta" : "text-[#687480]";
  return (
    <TgThemeContext.Provider value={theme}>
      <div className={`relative rounded-[52px] bg-[#1b1c1e] p-[10px] shadow-[0_2px_0_1px_#2c2d30_inset,0_40px_80px_-30px_rgb(0_0_0/0.45)] ${className}`}>
        <div className={`${night ? "tg-night" : "tg-day"} relative flex h-full flex-col overflow-hidden rounded-[43px]`}>
          <div className={`flex shrink-0 flex-col ${chrome} backdrop-blur`}>
            <div className="relative flex h-12 items-center justify-between px-8 pt-1 text-[15px] font-semibold">
              <span className="tabular-nums">{clock}</span>
              <span aria-hidden className="absolute left-1/2 top-3 h-[28px] w-[96px] -translate-x-1/2 rounded-full bg-black" />
              <span aria-hidden className="flex items-center gap-1.5">
                <svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor">
                  <rect x="0" y="7" width="3" height="4" rx="1" /><rect x="4.5" y="5" width="3" height="6" rx="1" />
                  <rect x="9" y="2.5" width="3" height="8.5" rx="1" /><rect x="13.5" y="0" width="3" height="11" rx="1" />
                </svg>
                <svg width="25" height="12" viewBox="0 0 25 12" fill="none">
                  <rect x="0.5" y="0.5" width="21" height="11" rx="3.5" stroke="currentColor" opacity=".4" />
                  <rect x="2" y="2" width="16" height="8" rx="2" fill="currentColor" />
                </svg>
              </span>
            </div>
            <div className={`flex items-center gap-3 border-b px-4 pb-2.5 pt-1 ${night ? "border-black/40" : "border-black/[0.07]"}`}>
              <svg aria-hidden width="11" height="18" viewBox="0 0 10 17" className="text-tg-link">
                <path d="M8.5 1.5 2 8.5l6.5 7" stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <div className="flex-1 text-center leading-tight">
                <p className="text-[16px] font-semibold">Perry</p>
                <p className={`text-[12.5px] ${status === "bot" ? sub : "text-tg-link"}`}>{status}</p>
              </div>
              <PerryAvatar className="size-9" />
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col justify-end gap-1.5 overflow-hidden px-2.5 pb-3 pt-2">{children}</div>
          <div aria-hidden className={`flex shrink-0 items-center gap-2.5 px-3 pb-7 pt-2.5 ${chrome}`}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={sub}>
              <path d="M21 11.5 12.6 19.9a5.4 5.4 0 0 1-7.6-7.6l8.5-8.5a3.6 3.6 0 0 1 5.1 5.1l-8.5 8.5a1.8 1.8 0 0 1-2.5-2.5l7.8-7.8" strokeLinecap="round" />
            </svg>
            <span className={`flex-1 rounded-full border px-4 py-1.5 text-[15px] ${night ? "border-white/10 bg-black/20" : "border-black/10 bg-white"} ${sub}`}>Message</span>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className={sub}>
              <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
            </svg>
          </div>
          <div aria-hidden className={`absolute bottom-2 left-1/2 h-[5px] w-32 -translate-x-1/2 rounded-full ${night ? "bg-white/70" : "bg-black/80"}`} />
        </div>
      </div>
    </TgThemeContext.Provider>
  );
}
