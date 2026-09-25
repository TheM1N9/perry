import { BlurWords } from "@/components/fx/BlurWords";
import { Reveal } from "@/components/fx/Reveal";
import { Platypus } from "@/components/mascot/Platypus";
import { HeroStage } from "./HeroStage";

export function Hero() {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative overflow-hidden">
      <div className="relative mx-auto grid max-w-[1200px] items-center gap-14 px-6 pb-24 pt-10 lg:min-h-[calc(100dvh-64px)] lg:grid-cols-[minmax(0,470px)_minmax(0,1fr)] lg:gap-10 lg:pb-16 lg:pt-6">
        <div>
          <div className="relative mb-6 w-fit">
            <Platypus className="relative" />
            <p className="absolute -right-24 top-6 hidden rotate-[-4deg] font-mono text-[12.5px] text-fg-3 sm:block">
              ← psst. poke him
            </p>
          </div>
          <p className="mb-4 font-mono text-[13px] text-brand">codename: perry · personal AI assistant</p>
          <BlurWords
            text="The only AI assistant you need."
            className="headline-gradient pb-2 text-[44px] font-[560] leading-[1.02] tracking-[-0.03em] sm:text-[56px] lg:text-[62px]"
          />
          <Reveal delay={0.45}>
            <p className="mt-6 max-w-[38ch] text-[18px] leading-[1.5] text-fg-2 lg:text-[19px]">
              Perry lives in your Telegram, remembers everything, tells no one, and gets real work done on your computer.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <a
                href="#install"
                className="inline-flex h-12 items-center rounded-full bg-brand px-6 text-[15.5px] font-semibold text-canvas transition-[filter,transform] hover:brightness-110 active:scale-[0.98]"
              >
                Recruit Perry
              </a>
            </div>
          </Reveal>
        </div>
        <HeroStage />
      </div>
    </section>
  );
}
