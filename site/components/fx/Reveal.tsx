"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

/** Rises into place once, the first time it scrolls into view. */
export function Reveal({
  children, delay = 0, className, as = "div",
}: { children: ReactNode; delay?: number; className?: string; as?: "div" | "li" }) {
  const Tag = as === "li" ? motion.li : motion.div;
  return (
    <Tag
      className={className}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-12% 0px" }}
      transition={{ duration: 0.7, delay, ease: [0.165, 0.84, 0.44, 1] }}
    >
      {children}
    </Tag>
  );
}
