"use client";

import { motion } from "motion/react";
import { BlurWords } from "@/components/fx/BlurWords";
import { Platypus } from "@/components/mascot/Platypus";

export function Hero() {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative overflow-hidden bg-paper">
      <div className="mx-auto flex max-w-[1180px] flex-col items-center px-6 pb-20 pt-14 text-center md:pb-24 md:pt-20">
        {/* Perry himself: the one place he's shown big. */}
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 220, damping: 22, delay: 0.1 }}
          className="relative"
        >
          <Platypus size="lg" />
          <p className="absolute -right-32 top-1/2 hidden rotate-[-4deg] text-[15px] font-medium italic text-ink-3 md:block">
            ← go on, poke him
          </p>
        </motion.div>
        <BlurWords
          text="Perry, the only AI assistant you need."
          className="mt-8 max-w-[15ch] text-[52px] font-[600] leading-[0.98] tracking-[-0.04em] text-ink sm:text-[72px] lg:text-[100px]"
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
    </section>
  );
}
