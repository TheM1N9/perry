"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/** Every Motion animation on the site honours the visitor's reduced-motion setting. */
export function Motion({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
