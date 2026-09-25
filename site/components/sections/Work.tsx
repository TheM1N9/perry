"use client";

import { motion } from "motion/react";
import { PlayToggle } from "@/components/fx/PlayToggle";
import { Reveal } from "@/components/fx/Reveal";
import { Section } from "@/components/fx/Section";
import { Window } from "@/components/mock/Window";
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

const POINTS = [
  { title: "Your subscription", body: "Perry thinks with the Codex CLI, signed in to your ChatGPT account. Pick the model and thinking level per chat." },
  { title: "Your folder, sandboxed", body: "Each chat works in a folder you choose, under Codex's sandbox: Seatbelt on macOS, bubblewrap on Linux, a restricted token on Windows." },
  { title: "Your receipts", body: "Every reply is a run on the Activity page, with each command, file change and tool call, its input and its output." },
];

export function Work() {
  const { ref, step, paused, toggle } = useSequence(HOLDS, { restartAfter: 4000 });
  return (
    <Section id="work" index="02" label="work" lead="Does the real work." rest="On your machine." intro="Perry hands each message to Codex on your computer, with a shell, your files and your tools, and keeps a receipt of everything it did.">
      <div ref={ref} data-step={step} className="relative mt-14 grid items-start gap-10 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Reveal>
          <Window title="Perry · Activity">
            <Trace shown={step} />
          </Window>
        </Reveal>
        <ul className="flex flex-col gap-7 lg:pt-4">
          {POINTS.map((point, i) => (
            <Reveal as="li" key={point.title} delay={0.08 * i} className="border-l border-line-strong pl-5">
              <p className="font-medium text-fg">{point.title}</p>
              <p className="mt-1 text-[15.5px] text-fg-3">{point.body}</p>
            </Reveal>
          ))}
        </ul>
        <PlayToggle paused={paused} onToggle={toggle} label="the activity demo" className="absolute -top-12 right-0" />
      </div>
    </Section>
  );
}
