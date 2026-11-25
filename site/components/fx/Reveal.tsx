"use client";

import { motion, useAnimationControls, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";

/** Rises into place once, the first time it scrolls into view. */
export function Reveal({
  children, delay = 0, className, as = "div",
}: { children: ReactNode; delay?: number; className?: string; as?: "div" | "li" }) {
  const Tag = as === "li" ? motion.li : motion.div;
  const ref = useRef<HTMLDivElement & HTMLLIElement>(null);
  const inView = useInView(ref, { once: true, margin: "-12% 0px" });
  const controls = useAnimationControls();
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!inView || reduced) return;
    void controls.start({ y: [20, 0], transition: { duration: 0.7, delay, ease: [0.165, 0.84, 0.44, 1] } });
    return () => controls.stop();
  }, [controls, delay, inView, reduced]);
  return (
    <Tag
      ref={ref}
      className={className}
      initial={false}
      animate={controls}
    >
      {children}
    </Tag>
  );
}
