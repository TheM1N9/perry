"use client";

import { AnimatePresence, motion, useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { PlayToggle } from "@/components/fx/PlayToggle";
import { Reveal } from "@/components/fx/Reveal";
import { Section } from "@/components/fx/Section";
import { Bubble } from "@/components/mock/Chat";
import { ChatPanel } from "@/components/mock/ChatPanel";

type Event = { at: number; name: string; kind: string; message?: string; quiet?: string };
const h = (hours: number, minutes = 0) => hours * 60 + minutes;
const EVENTS: Event[] = [
  { at: h(3), name: "Memory consolidation", kind: "built in", quiet: "moved two notes into long-term memory" },
  { at: h(8), name: "Calendar brief", kind: "every weekday at 8", message: "Morning. 10:30 design review with Ana, 13:00 lunch with Sam, 16:00 dentist." },
  { at: h(11), name: "Heartbeat", kind: "built in", quiet: "nothing needs you" },
  { at: h(14, 30), name: "Reminder", kind: "once, set at 14:10", message: "Call Sam." },
  { at: h(17), name: "Heartbeat", kind: "built in", message: "The Next.js releases page you asked me to watch changed: 16.3.7 is out, a security release." },
  { at: h(22, 30), name: "Daily summary", kind: "built in", quiet: "wrote today's notes" },
];
const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(Math.floor(minutes % 60)).padStart(2, "0")}`;

export function Schedule() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const [now, setNow] = useState(h(6, 30));
  const [paused, setPaused] = useState(false);

  // The day plays by itself while on screen, about 22 seconds from dawn to midnight, unless you take the dial.
  useEffect(() => {
    if (!inView || paused) return;
    const timer = setInterval(() => setNow((m) => (m >= h(24) - 1 ? 0 : Math.min(h(24) - 1, m + 6))), 90);
    return () => clearInterval(timer);
  }, [inView, paused]);

  const passed = EVENTS.filter((event) => event.at <= now);

  return (
    <Section id="schedule" index="04" label="schedule" lead="Shows up on time." rest="Quiet otherwise." intro="Briefs, reminders and check-ins on a schedule in your timezone, and silence when there's nothing worth saying. Drag the dial through a day.">
      <div ref={ref} className="relative mt-14 grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Reveal className="lit-border rounded-[22px] bg-surface p-6 md:p-8">
          <div className="flex items-baseline justify-between">
            <p className="font-mono text-[40px] font-medium tabular-nums tracking-tight text-fg md:text-[56px]" aria-live="off">{clock(now)}</p>
            <p className="font-mono text-[12.5px] text-fg-3">in your timezone</p>
          </div>

          <div className="relative mt-8 h-14">
            <div className="absolute inset-x-0 top-6 h-px bg-line-strong" />
            <div className="absolute left-0 top-6 h-px bg-accent" style={{ width: `${(now / h(24)) * 100}%` }} />
            {EVENTS.map((event, i) => {
              const done = event.at <= now;
              return (
                <span
                  key={i}
                  aria-hidden
                  className={`absolute top-[18px] size-3 -translate-x-1/2 rounded-full border-2 transition-colors ${
                    done ? (event.message ? "border-accent bg-accent" : "border-fg-3 bg-fg-3") : "border-line-strong bg-surface"
                  }`}
                  style={{ left: `${(event.at / h(24)) * 100}%` }}
                />
              );
            })}
            <input
              type="range"
              min={0}
              max={h(24) - 1}
              step={5}
              value={now}
              onChange={(e) => { setNow(Number(e.target.value)); setPaused(true); }}
              aria-label="Time of day"
              aria-valuetext={clock(now)}
              className="absolute inset-x-0 top-3 h-7 w-full cursor-grab appearance-none bg-transparent active:cursor-grabbing [&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-fg [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-fg [&::-webkit-slider-thumb]:shadow-[0_0_0_6px_rgb(255_255_255/0.08)]"
            />
          </div>
          <div aria-hidden className="mt-1 flex justify-between font-mono text-[11.5px] text-fg-3">
            <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
          </div>

          <ol className="mt-8 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {EVENTS.map((event, i) => {
              const done = event.at <= now;
              return (
                <li key={i} className={`flex gap-3 text-[14.5px] transition-opacity duration-300 ${done ? "opacity-100" : "opacity-45"}`}>
                  <span className="w-12 shrink-0 font-mono text-[13px] tabular-nums text-fg-3">{clock(event.at)}</span>
                  <span>
                    <span className="text-fg">{event.name}</span>
                    <span className="block text-[13px] text-fg-3">
                      {event.kind}
                      {event.quiet ? ` · ${done ? `stayed quiet: ${event.quiet}` : "stays quiet unless needed"}` : ""}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        </Reveal>

        <Reveal delay={0.1}>
          <ChatPanel className="h-[500px]">
            <AnimatePresence initial={false} mode="popLayout">
              {passed.length === 0 ? (
                <motion.p key="none" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mx-auto mb-4 w-fit rounded-full bg-black/30 px-3 py-1 text-[12px] text-tg-meta">
                  Nothing yet today
                </motion.p>
              ) : null}
              {passed.map((event) =>
                event.message ? (
                  <Bubble key={event.at} side="in" time={clock(event.at)}>{event.message}</Bubble>
                ) : (
                  <motion.p key={event.at} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto w-fit shrink-0 rounded-full bg-black/30 px-3 py-1 text-[12px] text-tg-meta">
                    {clock(event.at)} · {event.name.toLowerCase()} · no message
                  </motion.p>
                ),
              )}
            </AnimatePresence>
          </ChatPanel>
          <p className="mt-4 text-[14.5px] text-fg-3">
            Ask in plain words: “every weekday at 8, brief me on my calendar”, or “remind me in 20 minutes to call Sam”.
          </p>
        </Reveal>
        <PlayToggle paused={paused} onToggle={() => setPaused((p) => !p)} label="the day" className="absolute -top-12 right-0" />
      </div>
    </Section>
  );
}
