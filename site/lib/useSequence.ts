"use client";

import { useInView } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Plays a scripted demo one step at a time: `holds[i]` is how long step i
 * stays on screen before step i + 1. It plays only while its element is on
 * screen, and can be paused. Under reduced motion it still plays, since it
 * changes content rather than moving things; MotionConfig strips the movement.
 */
export function useSequence<T extends Element = HTMLDivElement>(
  holds: readonly number[],
  { loop = true, restartAfter = 3200, amount = 0.35 }: { loop?: boolean; restartAfter?: number; amount?: number } = {},
) {
  const ref = useRef<T>(null);
  const inView = useInView(ref, { amount });
  const last = holds.length;
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!inView || paused) return;
    const wait = step < last ? holds[step] : loop ? restartAfter : null;
    if (wait == null) return;
    const timer = setTimeout(() => setStep((s) => (s < last ? s + 1 : 0)), wait);
    return () => clearTimeout(timer);
  }, [step, inView, paused, last, holds, loop, restartAfter]);

  const restart = useCallback(() => setStep(0), []);
  const toggle = useCallback(() => setPaused((p) => !p), []);
  return { ref, step, paused, toggle, restart };
}
