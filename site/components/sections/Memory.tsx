"use client";

import { AnimatePresence, motion } from "motion/react";
import { PlayToggle } from "@/components/fx/PlayToggle";
import { Reveal } from "@/components/fx/Reveal";
import { Section } from "@/components/fx/Section";
import { Bubble, Typing } from "@/components/mock/Chat";
import { ChatPanel } from "@/components/mock/ChatPanel";
import { Window } from "@/components/mock/Window";
import { useSequence } from "@/lib/useSequence";

const HOLDS = [1100, 900, 1300, 1700, 1300, 1100] as const;

type Memory = { text: string; from: string; fresh?: boolean };
const LAYERS: { name: string; when: string; items: Memory[] }[] = [
  {
    name: "Profile",
    when: "in every reply",
    items: [
      { text: "Keep replies short. Bullet points over paragraphs.", from: "you" },
      { text: "Ask Ana about anything design.", from: "you" },
    ],
  },
  {
    name: "Long-term",
    when: "recalled when it matters",
    items: [
      { text: "The site deploys from main, on Vercel.", from: "you" },
      { text: "Sam's birthday is 14 March.", from: "you" },
    ],
  },
  {
    name: "Daily notes",
    when: "today and yesterday; older by search",
    items: [
      { text: "Design review moved to 10:30.", from: "a job" },
      { text: "Fixed the lockfile on main.", from: "the chat" },
    ],
  },
];

function Card({ memory }: { memory: Memory }) {
  return (
    <motion.li
      layout
      initial={memory.fresh ? { opacity: 0, y: -24, scale: 0.95 } : false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 300, damping: 26 }}
      className={`rounded-[12px] border px-3.5 py-3 text-[14px] leading-snug ${
        memory.fresh ? "border-ok/40 bg-ok/10 text-fg" : "border-line bg-surface-2 text-fg-2"
      }`}
    >
      {memory.text}
      <span className={`mt-2 block font-mono text-[11.5px] ${memory.fresh ? "text-ok" : "text-fg-3"}`}>
        {memory.fresh ? "new · " : ""}from {memory.from}
      </span>
    </motion.li>
  );
}

export function Memory() {
  const { ref, step: s, paused, toggle } = useSequence(HOLDS, { restartAfter: 4500 });
  const layers = LAYERS.map((layer, i) =>
    i === 0 && s >= 2 ? { ...layer, items: [{ text: "Drinks coffee black.", from: "you", fresh: true }, ...layer.items] } : layer,
  );

  return (
    <Section id="memory" index="01" label="memory" lead="Remembers you." rest="And shows you what." intro="Your preferences, the facts that matter and what happened today, kept in three layers you can read and edit from the dashboard.">
      <div ref={ref} data-step={s} className="relative mt-14 grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)]">
        <Reveal>
          <ChatPanel className="h-[440px]">
            <AnimatePresence initial={false} mode="popLayout">
              <Bubble key="a" side="out" time="09:14">remember that I drink my coffee black</Bubble>
              {s === 0 ? <Typing key="t0" /> : null}
              {s >= 1 ? <Bubble key="b" side="in" time="09:14">Noted.</Bubble> : null}
              {s >= 3 ? <Bubble key="c" side="out" time="17:02">grabbing coffee for the team, what&apos;s my usual?</Bubble> : null}
              {s === 4 ? <Typing key="t1" /> : null}
              {s >= 5 ? (
                <Bubble key="d" side="in" time="17:02">
                  Black, no sugar. Want me to add Ana&apos;s oat flat white to the list? She asked for one on Tuesday.
                </Bubble>
              ) : null}
            </AnimatePresence>
          </ChatPanel>
        </Reveal>
        <Reveal delay={0.1}>
          <Window title="Perry · Memory" bodyClassName="grid gap-px bg-line md:grid-cols-3">
            {layers.map((layer) => (
              <div key={layer.name} className="bg-surface p-4 md:min-h-[400px]">
                <p className="text-[15px] font-semibold text-fg">{layer.name}</p>
                <p className="mb-4 font-mono text-[11.5px] text-fg-3">{layer.when}</p>
                <ul className="flex flex-col gap-2.5">
                  <AnimatePresence initial={false}>
                    {layer.items.map((memory) => (
                      <Card key={memory.text} memory={memory} />
                    ))}
                  </AnimatePresence>
                </ul>
              </div>
            ))}
          </Window>
        </Reveal>
        <PlayToggle paused={paused} onToggle={toggle} label="the memory demo" className="absolute -top-12 right-0" />
      </div>
      <Reveal delay={0.15}>
        <dl className="mt-10 grid gap-x-10 gap-y-5 text-[15px] md:grid-cols-3">
          <div>
            <dt className="font-medium text-fg">Superseded, never silently dropped</dt>
            <dd className="text-fg-3">A fact that changes replaces the old one, and a full memory refuses new saves rather than forgetting.</dd>
          </div>
          <div>
            <dt className="font-medium text-fg">Data, not instructions</dt>
            <dd className="text-fg-3">What Perry recalls reaches it marked as possibly incomplete or out of date, and never as instructions to follow.</dd>
          </div>
          <div>
            <dt className="font-medium text-fg">Tidied overnight</dt>
            <dd className="text-fg-3">At 22:30 the day becomes notes; at 03:00 what lasted moves into your profile and long-term memory.</dd>
          </div>
        </dl>
      </Reveal>
    </Section>
  );
}
