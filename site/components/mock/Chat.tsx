"use client";

import { motion } from "motion/react";
import { createContext, useContext, type ReactNode } from "react";

/** Which Telegram theme the chat is drawn in: day on the light page, night for the night watch. */
export type TgTheme = "day" | "night";
export const TgThemeContext = createContext<TgTheme>("day");

const pop = {
  initial: { opacity: 0, y: 14, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, transition: { duration: 0.15 } },
  transition: { type: "spring" as const, stiffness: 420, damping: 32 },
};

const SKIN = {
  day: {
    in: "bg-tg-in text-[#000]",
    out: "bg-tg-out text-[#000]",
    meta: "text-tg-meta",
    outMeta: "text-[#357d32]",
    shadow: "shadow-[0_1px_1px_rgb(0_0_0/0.13)]",
  },
  night: {
    in: "bg-tgn-in text-white",
    out: "bg-tgn-out text-white",
    meta: "text-tgn-meta",
    outMeta: "text-[#b4d0ea]",
    shadow: "",
  },
};

/** A Telegram message bubble. `out` is you; `in` is Perry. */
export function Bubble({ side, time, children, className = "" }: { side: "in" | "out"; time?: string; children: ReactNode; className?: string }) {
  const skin = SKIN[useContext(TgThemeContext)];
  const out = side === "out";
  return (
    <motion.div
      layout="position"
      {...pop}
      style={{ originX: out ? 1 : 0, originY: 1 }}
      className={`relative w-fit max-w-[84%] shrink-0 rounded-[17px] px-3 pb-[19px] pt-[7px] text-[15px] leading-[1.36] ${skin.shadow} ${
        out ? `ml-auto rounded-br-[5px] ${skin.out}` : `rounded-bl-[5px] ${skin.in}`
      } ${className}`}
    >
      {children}
      {time ? (
        <span className={`absolute bottom-[3px] right-2.5 flex items-center gap-0.5 text-[11.5px] ${out ? skin.outMeta : skin.meta}`}>
          {time}
          {out ? (
            <svg aria-hidden width="16" height="10" viewBox="0 0 16 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m1 5.5 2.8 2.8L9.5 2.2M6.5 8.3 12.5 2.2" />
            </svg>
          ) : null}
        </span>
      ) : null}
    </motion.div>
  );
}

/** Perry is typing. */
export function Typing() {
  const skin = SKIN[useContext(TgThemeContext)];
  return (
    <motion.div
      layout="position"
      {...pop}
      style={{ originX: 0, originY: 1 }}
      role="status"
      aria-label="Perry is typing"
      className={`flex w-fit shrink-0 items-center gap-1 rounded-[17px] rounded-bl-[5px] px-3.5 py-3 ${skin.in} ${skin.shadow}`}
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-[7px] rounded-full bg-current opacity-40"
          animate={{ opacity: [0.25, 0.7, 0.25], y: [0, -2, 0] }}
          transition={{ duration: 1, repeat: Infinity, delay: i * 0.16 }}
        />
      ))}
    </motion.div>
  );
}

/** Telegram's date and notice pill. */
export function Pill({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <motion.p layout="position" {...pop} className={`tg-pill mx-auto w-fit shrink-0 rounded-full px-2.5 py-0.5 text-center text-[12.5px] font-medium ${className}`}>
      {children}
    </motion.p>
  );
}

/** Telegram's inline keyboard: the buttons under a bot's message. */
export function InlineKeys({ children, label }: { children: ReactNode; label: string }) {
  return (
    <motion.div layout="position" {...pop} role="group" aria-label={label} className="mt-0.5 grid w-[84%] shrink-0 grid-cols-2 gap-1">
      {children}
    </motion.div>
  );
}

export function Key({
  children, onClick, wide, ...rest
}: { children: ReactNode; onClick?: () => void; wide?: boolean; "data-answer"?: string }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileTap={{ scale: 0.95 }}
      className={`rounded-[10px] bg-black/50 px-2 py-2 text-[14px] font-semibold text-white backdrop-blur-md transition-colors hover:bg-black/60 ${wide ? "col-span-2" : ""}`}
      {...rest}
    >
      {children}
    </motion.button>
  );
}
