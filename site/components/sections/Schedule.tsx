"use client";

import { AnimatePresence, motion, useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { PlayToggle } from "@/components/fx/PlayToggle";
import { Reveal } from "@/components/fx/Reveal";
import { Section } from "@/components/fx/Section";
import { Bubble } from "@/components/mock/Chat";
import { ChatPanel } from "@/components/mock/ChatPanel";

type Event = { at: number; name: string; tag: string; kind: string; message?: string; quiet?: string };
const h = (hours: number, minutes = 0) => hours * 60 + minutes;
const EVENTS: Event[] = [
  { at: h(3), name: "Memory consolidation", tag: "memory", kind: "built in", quiet: "moved two notes into long-term memory" },
  { at: h(8), name: "Calendar brief", tag: "brief", kind: "every weekday at 8", message: "Morning. 10:30 design review with Ana, 13:00 lunch with Sam, 16:00 dentist." },
  { at: h(11), name: "Heartbeat", tag: "check-in", kind: "built in", quiet: "nothing needs you" },
  { at: h(14, 30), name: "Reminder", tag: "Sam", kind: "once, set at 14:10", message: "Call Sam." },
  { at: h(17), name: "Heartbeat", tag: "check-in", kind: "built in", message: "The Next.js releases page you asked me to watch changed: 16.3.7 is out, a security release." },
  { at: h(22, 30), name: "Daily summary", tag: "notes", kind: "built in", quiet: "wrote today's notes" },
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
  const next = EVENTS.find((event) => event.at > now);

  return (
    <Section id="schedule" index="04" label="schedule" lead="Reports in on time.">
      <div ref={ref} className="showcase mt-14 grid items-stretch gap-6 p-4 pt-14 md:p-10 md:pt-14 lg:grid-cols-[minmax(0,1fr)_380px]">
        <Reveal className="flex flex-col justify-between rounded-[20px] border border-white/10 bg-black/35 p-6 backdrop-blur md:p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[48px] font-medium leading-none tabular-nums tracking-tight text-fg md:text-[72px]" aria-live="off">{clock(now)}</p>
              <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 font-mono text-[12.5px] text-fg-2">
                <span aria-hidden className="size-1.5 rounded-full bg-brand" />
                next · {next ? `${clock(next.at)} ${next.name.toLowerCase()}` : "tomorrow's brief"}
              </p>
            </div>
            <p className="font-mono text-[12.5px] text-fg-3">in your timezone</p>
          </div>

          <div className="relative mt-12 h-14">
            <div className="absolute inset-x-0 top-6 h-px bg-line-strong" />
            <div className="absolute left-0 top-6 h-px bg-accent" style={{ width: `${(now / h(24)) * 100}%` }} />
            {EVENTS.map((event, i) => {
              const done = event.at <= now;
              return (
                <span key={i} aria-hidden>
                  <span
                    className={`absolute -top-5 -translate-x-1/2 whitespace-nowrap font-mono text-[11px] transition-colors ${done ? "text-fg-2" : "text-fg-3"}`}
                    style={{ left: `${(event.at / h(24)) * 100}%` }}
                  >
                    {event.tag}
                  </span>
                  <span
                  className={`absolute top-[18px] size-3 -translate-x-1/2 rounded-full border-2 transition-colors ${
                    done ? (event.message ? "border-accent bg-accent" : "border-fg-3 bg-fg-3") : "border-line-strong bg-surface"
                  }`}
                  style={{ left: `${(event.at / h(24)) * 100}%` }}
                  />
                </span>
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
        </Reveal>

        <Reveal delay={0.1}>
          <ChatPanel className="h-[400px]">
            <AnimatePresence initial={false} mode="popLayout">
              {passed.length === 0 ? (
                <motion.p key="none" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mx-auto mb-4 w-fit tg-service rounded-full px-3 py-1 text-[12px]">
                  Nothing yet today
                </motion.p>
              ) : null}
              {passed.map((event) =>
                event.message ? (
                  <Bubble key={event.at} side="in" time={clock(event.at)}>{event.message}</Bubble>
                ) : (
                  <motion.p key={event.at} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mx-auto w-fit shrink-0 tg-service rounded-full px-3 py-1 text-[12px]">
                    {clock(event.at)} · {event.name.toLowerCase()} · no message
                  </motion.p>
                ),
              )}
            </AnimatePresence>
          </ChatPanel>
        </Reveal>
        <PlayToggle paused={paused} onToggle={() => setPaused((p) => !p)} label="the day" className="absolute right-4 top-4 z-20" />
      </div>
    </Section>
  );
}
