"use client";

import { motion } from "motion/react";
import { PlayToggle } from "@/components/fx/PlayToggle";
import { Reveal } from "@/components/fx/Reveal";
import { Section } from "@/components/fx/Section";
import { Window } from "@/components/mock/Window";
import { AnimatePresence } from "motion/react";
import { PlatypusHead } from "@/components/mascot/PlatypusHead";
import { useSequence } from "@/lib/useSequence";

// Where each step starts and how long it runs, as shares of the whole turn.
const STEPS = [
  { kind: "thinking", what: "reasoning", start: 0, span: 8, time: "1.9 s" },
  { kind: "search", what: "rg \"frozen-lockfile\" .github", start: 8, span: 3, time: "0.4 s" },
  { kind: "shell", what: "gh run view --log-failed", start: 11, span: 6, time: "1.3 s" },
  { kind: "shell", what: "pnpm install", note: "approved by you", start: 17, span: 27, time: "6.4 s" },
  { kind: "files", what: "pnpm-lock.yaml", start: 44, span: 2, time: "0.2 s" },
  { kind: "shell", what: "pnpm build", start: 46, span: 52, time: "14.2 s" },
] as const;
const HOLDS = [700, ...STEPS.map(() => 750)] as const;

function Trace({ shown }: { shown: number }) {
  const done = shown > STEPS.length;
  return (
    <div className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[15.5px] font-semibold text-fg">the site build is failing on main, can you look?</p>
          <p className="mt-1 font-mono text-[12px] text-fg-3">Telegram · codex · 6 steps · 23.8 s · 41,206 tokens</p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium ${done ? "bg-ok/10 text-ok" : "bg-white/5 text-fg-2"}`}>
          {done ? "Completed" : "Running"}
        </span>
      </div>
      <ol className="mt-5 flex flex-col">
        {STEPS.map((step, i) => {
          const visible = shown > i;
          return (
            <li key={i} className="grid grid-cols-[64px_minmax(0,1fr)_52px] items-center gap-3 border-t border-line py-2.5 font-mono text-[12.5px] md:grid-cols-[72px_minmax(0,1fr)_minmax(0,34%)_56px]">
              <span className="text-fg-3">{step.kind}</span>
              <span className={`truncate transition-colors duration-300 ${visible ? "text-fg" : "text-fg-3"}`}>
                {step.what}
                {"note" in step ? <span className="ml-2 font-sans text-[12px] text-ok">{visible ? step.note : ""}</span> : null}
              </span>
              <span className="relative hidden h-1 rounded-full bg-white/[0.06] md:block">
                <motion.span
                  className="absolute inset-y-0 rounded-full bg-fg-2"
                  style={{ left: `${step.start}%` }}
                  initial={false}
                  animate={{ width: visible ? `${Math.max(step.span, 1.5)}%` : "0%" }}
                  transition={{ duration: 0.6, ease: [0.165, 0.84, 0.44, 1] }}
                />
              </span>
              <span className="text-right tabular-nums text-fg-2">{visible ? step.time : ""}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}


export function Work() {
  const { ref, step, paused, toggle } = useSequence(HOLDS, { restartAfter: 4000 });
  return (
    <Section id="work" index="02" label="work" lead="Works undercover." rest="On your computer.">
      <div ref={ref} data-step={step} className="showcase mt-14 px-4 pb-16 pt-14 md:px-14 md:pb-20 md:pt-16">
        <Reveal className="mx-auto max-w-[860px]">
          <Window title="Perry · Activity">
            <Trace shown={step} />
          </Window>
        </Reveal>
        {/* When the run finishes, the reply lands on your phone. */}
        <AnimatePresence>
          {step > STEPS.length ? (
            <motion.div
              key="done"
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              className="absolute bottom-6 right-4 z-10 flex w-[300px] items-start gap-3 rounded-2xl border border-white/10 bg-[#1c2733]/95 p-3.5 shadow-[0_20px_50px_rgb(0_0_0/0.6)] backdrop-blur md:bottom-10 md:right-10"
            >
              <PlatypusHead className="size-9" />
              <div className="min-w-0 text-[13.5px] leading-snug">
                <p className="flex justify-between font-semibold text-white">Perry <span className="font-normal text-tg-meta">now</span></p>
                <p className="text-[#c9d6e2]">Fixed. Build passes, and nobody saw a thing.</p>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <PlayToggle paused={paused} onToggle={toggle} label="the activity demo" className="absolute right-4 top-4 z-20" />
      </div>
    </Section>
  );
}
