"use client";

import { startTransition, useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { usePageVisible } from "./use-page-visible";

// Adapted from whirl (MIT): apps/v2/lib/use-typewriter.ts

/* Network chunks land in bursts; revealing them verbatim makes streamed text
   lurch. This meters the reveal: every tick shows an eighth of what is still
   outstanding, clamped to 1..64 characters, so the tail types briskly after a
   big burst and settles to a gentle drip as it catches up.

   Text already on screen when the reply mounts is shown whole, so opening a
   chat mid-reply never types out what was already there. */

const TICK_MS = 28;
const MAX_STEP = 64;

/* Every tick re-renders the whole reply and re-parses its Markdown — work that
   grows with the reply while the tick rate stayed flat, so a long answer spent
   more and more of each second re-reading what it had already written. Long
   replies tick less often and reveal proportionally more each time: the same
   characters per second, a fraction of the renders. Reading speed doesn't
   change; only the frame rate of the reveal does, and by the time it drops
   there is far too much text on screen for anyone to be watching a single
   character land. */
function cadenceFor(length: number): { tickMs: number; scale: number } {
  const tickMs = length < 6_000 ? TICK_MS : length < 20_000 ? 56 : 96;
  return { tickMs, scale: tickMs / TICK_MS };
}

/** What has streamed so far, revealed at a steady rate instead of in the bursts it landed in. */
export function useTypewriter(sourceText: string): string {
  const [visibleCount, setVisibleCount] = useState(() => sourceText.length);
  const visible = usePageVisible();
  const reduced = useReducedMotion();

  /* A reply arriving in a tab nobody is looking at, or for someone who asked
     for less motion, gets handed over whole: metering it out costs a re-render
     — and a full re-read of the reply — every tick, for an animation with no
     audience, and the backlog it builds is exactly what makes a tab feel
     wrecked on the way back in. Catching up at once also means there is
     nothing left to replay when it returns: the text is simply there. */
  if ((!visible || reduced) && visibleCount < sourceText.length) {
    setVisibleCount(sourceText.length);
  }

  /* A retried message starts a fresh, shorter stream — never point past the
     end of the new text. */
  const clamped = Math.min(visibleCount, sourceText.length);
  const caughtUp = clamped >= sourceText.length;

  useEffect(() => {
    if (caughtUp || !visible || reduced) return;
    const { tickMs, scale } = cadenceFor(sourceText.length);
    const timer = window.setInterval(() => {
      startTransition(() => {
        setVisibleCount((count) => {
          const current = Math.min(count, sourceText.length);
          const remaining = sourceText.length - current;
          if (remaining <= 0) return count;
          return current + Math.min(MAX_STEP * scale, Math.max(1, Math.ceil((remaining * scale) / 8)));
        });
      });
    }, tickMs);
    return () => window.clearInterval(timer);
  }, [sourceText, caughtUp, visible, reduced]);

  return sourceText.slice(0, clamped);
}
