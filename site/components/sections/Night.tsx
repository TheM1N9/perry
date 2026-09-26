"use client";

import { AnimatePresence, useInView } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Reveal } from "@/components/fx/Reveal";
import { PlatypusArt } from "@/components/mascot/Platypus";
import { Bubble, Pill } from "@/components/mock/Chat";
import { Phone } from "@/components/mock/Phone";

/** 23:00: the page's one dark scene. Perry dozes; the night still gets its work done. */
export function Night() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!inView || step >= 2) return;
    const timer = setTimeout(() => setStep((s) => s + 1), step === 0 ? 700 : 1500);
    return () => clearTimeout(timer);
  }, [inView, step]);

  return (
    <section id="night" aria-labelledby="night-title" className="bg-night text-white">
      <div ref={ref} className="mx-auto grid max-w-[1180px] items-center gap-16 px-6 py-28 md:py-36 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-20">
        <Reveal>
          <p className="text-[20px] font-semibold tabular-nums tracking-[-0.01em] text-[#5fd4c8]">23:00</p>
          <h2 id="night-title" className="mt-3 max-w-[13ch] text-[44px] font-[600] leading-[1.02] tracking-[-0.035em] md:text-[72px]">
            Off the clock. Still on watch.
          </h2>
          <p className="mt-6 max-w-[36ch] text-[19px] leading-[1.5] text-[#a1a1a6]">
            Overnight Perry files the day into notes and keeps an eye on the pages you care about. It only wakes you if something matters.
          </p>
        </Reveal>
        <div className="relative mx-auto">
          <Phone theme="night" className="w-[320px] md:w-[340px]" clock={step >= 2 ? "02:13" : "23:00"}>
            <AnimatePresence initial={false} mode="popLayout">
              <Pill key="today">Today</Pill>
              {step >= 1 ? <Pill key="notes">22:30 · today&apos;s notes filed</Pill> : null}
              {step >= 2 ? <Pill key="date">Wednesday</Pill> : null}
              {step >= 2 ? (
                <Bubble key="watch" side="in" time="02:13">
                  Next.js 16.3.7 is out, a security patch for your site. It&apos;s in your 7:00 brief. Back to sleep.
                </Bubble>
              ) : null}
            </AnimatePresence>
          </Phone>
          <div className="absolute -bottom-6 -left-24 w-[150px] md:-left-32 md:w-[170px]">
            <PlatypusArt asleep className="h-auto w-full" />
          </div>
        </div>
      </div>
    </section>
  );
}
