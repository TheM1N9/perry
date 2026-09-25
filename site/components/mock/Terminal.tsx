"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

type Kind = "cmd" | "out" | "err" | "ok" | "dim" | "wait";
const tone: Record<Kind, string> = {
  cmd: "text-fg",
  out: "text-fg-2",
  err: "text-bad",
  ok: "text-ok",
  dim: "text-fg-3",
  wait: "text-warn",
};

/** One terminal line, arriving as if printed. */
export function Line({ kind = "out", children }: { kind?: Kind; children: ReactNode }) {
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.25 }}
      className={`whitespace-pre-wrap break-words ${tone[kind]}`}
    >
      {kind === "cmd" ? <span className="select-none text-fg-3">$ </span> : null}
      {children}
    </motion.div>
  );
}

export function Cursor() {
  return <span aria-hidden className="inline-block h-[1.05em] w-[0.55em] translate-y-[2px] bg-fg-2 motion-safe:animate-blink" />;
}
