"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { BlurWords } from "@/components/fx/BlurWords";
import { Platypus } from "@/components/mascot/Platypus";
import { Bubble, Typing } from "@/components/mock/Chat";
import { Phone } from "@/components/mock/Phone";

// Things you might ask Perry first, and what he says back.
const ASKS = [
  { ask: "Brief me every morning", reply: "Done. Weekdays at 7:00: your calendar, inbox and the weather. The first one's tomorrow." },
  { ask: "Clean up my Downloads", reply: "On it, on your computer. I'll show you what goes before anything is deleted." },
  { ask: "Remind me to call Sam at 6", reply: "18:00, call Sam. I'll nudge you." },
] as const;

export function Hero() {
  const [asked, setAsked] = useState<number[]>([]);
  const [typing, setTyping] = useState(false);

  const ask = (i: number) => {
    if (typing || asked.includes(i)) return;
    setAsked((list) => [...list, i]);
    setTyping(true);
    setTimeout(() => setTyping(false), 850);
  };
  const last = asked.at(-1);

  return (
    <section id="top" aria-labelledby="hero-title" className="relative overflow-hidden bg-paper">
      <div className="mx-auto flex max-w-[1180px] flex-col items-center px-6 pt-16 text-center md:pt-24">
        <p className="font-mono text-[14px] text-teal">Perry · your personal AI assistant</p>
        <BlurWords
          text="The only AI assistant you need."
          className="mt-5 max-w-[14ch] text-[52px] font-[600] leading-[0.98] tracking-[-0.04em] text-ink sm:text-[72px] lg:text-[100px]"
        />
        <motion.p
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.5 }}
          className="mt-7 max-w-[34ch] text-[19px] leading-[1.45] text-ink-3 md:text-[22px]"
        >
          Perry lives in your Telegram, works on your own computer, and never makes a risky move without you.
        </motion.p>
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, delay: 0.65 }} className="mt-9 flex flex-wrap justify-center gap-3">
          <a href="#setup" className="inline-flex h-12 items-center rounded-full bg-teal px-7 text-[16px] font-semibold text-white transition-colors hover:bg-[#0a6a61]">
            Get Perry
          </a>
          <a href="#day" className="inline-flex h-12 items-center rounded-full px-5 text-[16px] font-medium text-teal hover:underline">
            See a day with Perry →
          </a>
        </motion.div>
      </div>

      <div className="relative mx-auto mt-16 flex max-w-[1180px] items-end justify-center px-6 pb-28 md:mt-20 md:pb-36">
        <div className="absolute bottom-40 left-[calc(50%-400px)] hidden md:block md:bottom-48">
          <Platypus size="lg" />
          <p className="mt-2 rotate-[-3deg] text-center font-mono text-[13px] text-ink-3">go on, poke him</p>
        </div>
        <Phone className="h-[580px] w-[340px] md:w-[372px]" status={typing ? "typing…" : "bot"}>
          <AnimatePresence initial={false} mode="popLayout">
            <Bubble key="hi" side="in" time="9:41">
              Hi, I&apos;m Perry. I work on your computer, remember what matters, and ask before anything risky. What should we do first?
            </Bubble>
            {asked.flatMap((i) => [
              <Bubble key={`ask-${i}`} side="out" time="9:41">{ASKS[i].ask}</Bubble>,
              typing && i === last ? <Typing key={`typing-${i}`} /> : <Bubble key={`reply-${i}`} side="in" time="9:41">{ASKS[i].reply}</Bubble>,
            ])}
          </AnimatePresence>
          {/* Telegram's reply keyboard: the suggestions you can tap. */}
          <div role="group" aria-label="Reply to Perry" className="mt-1 flex shrink-0 flex-col gap-1">
            {ASKS.map((item, i) =>
              asked.includes(i) ? null : (
                <motion.button
                  key={item.ask}
                  type="button"
                  layout
                  data-ask={i}
                  onClick={() => ask(i)}
                  whileTap={{ scale: 0.97 }}
                  className="rounded-[10px] bg-black/50 px-3 py-2 text-[14.5px] font-semibold text-white backdrop-blur-md transition-colors hover:bg-black/60"
                >
                  {item.ask}
                </motion.button>
              ),
            )}
          </div>
        </Phone>
      </div>
    </section>
  );
}
