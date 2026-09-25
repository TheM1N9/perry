"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

const pop = {
  initial: { opacity: 0, y: 14, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, transition: { duration: 0.15 } },
  transition: { type: "spring" as const, stiffness: 420, damping: 32 },
};

/** A Telegram message bubble. `out` is you; `in` is Perry. */
export function Bubble({
  side, time, children, className = "",
}: { side: "in" | "out"; time?: string; children: ReactNode; className?: string }) {
  const out = side === "out";
  return (
    <motion.div
      layout="position"
      {...pop}
      style={{ originX: out ? 1 : 0, originY: 1 }}
      className={`relative w-fit max-w-[84%] shrink-0 rounded-[16px] px-3 pb-[18px] pt-[7px] text-[14.5px] leading-[1.38] text-white ${
        out ? "ml-auto rounded-br-[5px] bg-tg-out" : "rounded-bl-[5px] bg-tg-in"
      } ${className}`}
    >
      {children}
      {time ? (
        <span className={`absolute bottom-[3px] right-2.5 flex items-center gap-0.5 text-[11px] ${out ? "text-[#b4d0ea]" : "text-tg-meta"}`}>
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
  return (
    <motion.div
      layout="position"
      {...pop}
      style={{ originX: 0, originY: 1 }}
      role="status"
      aria-label="Perry is typing"
      className="flex w-fit shrink-0 items-center gap-1 rounded-[16px] rounded-bl-[5px] bg-tg-in px-3.5 py-3"
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-[7px] rounded-full bg-tg-meta"
          animate={{ opacity: [0.35, 1, 0.35], y: [0, -2, 0] }}
          transition={{ duration: 1, repeat: Infinity, delay: i * 0.16 }}
        />
      ))}
    </motion.div>
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
  children, wide, onClick, pressed, disabled, className = "", ...rest
}: {
  children: ReactNode; wide?: boolean; onClick?: () => void; pressed?: boolean; disabled?: boolean; className?: string;
  "data-answer"?: string;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      animate={pressed ? { scale: [1, 0.93, 1] } : { scale: 1 }}
      transition={{ duration: 0.3 }}
      className={`relative rounded-[10px] px-2 py-2 text-[13.5px] font-semibold text-white backdrop-blur-md transition-colors enabled:hover:bg-black/55 disabled:cursor-default ${
        pressed ? "bg-white/25" : "bg-black/40"
      } ${wide ? "col-span-2" : ""} ${className}`}
      {...rest}
    >
      {children}
    </motion.button>
  );
}

/** A finger tap, drawn where the demo presses a button. */
export function Tap() {
  return (
    <motion.span
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-1/2 size-9 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/80 bg-white/25"
      initial={{ scale: 0.4, opacity: 0 }}
      animate={{ scale: [0.4, 1, 1.5], opacity: [0, 1, 0] }}
      transition={{ duration: 0.7, ease: "easeOut" }}
    />
  );
}
