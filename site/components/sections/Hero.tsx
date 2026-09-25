import { BlurWords } from "@/components/fx/BlurWords";
import { Reveal } from "@/components/fx/Reveal";
import { Spotlight } from "@/components/fx/Spotlight";
import { HeroStage } from "./HeroStage";

export function Hero() {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative overflow-hidden">
      <Spotlight className="-top-40 h-[520px]" />
      <div className="relative mx-auto grid max-w-[1200px] items-center gap-14 px-6 pb-24 pt-14 lg:min-h-[calc(100dvh-64px)] lg:grid-cols-[minmax(0,470px)_minmax(0,1fr)] lg:gap-10 lg:pb-16 lg:pt-10">
        <div>
          <BlurWords
            text="Meet Perry, the assistant that works on your computer."
            className="headline-gradient pb-2 text-[44px] font-[560] leading-[1.02] tracking-[-0.03em] sm:text-[56px] lg:text-[62px]"
          />
          <Reveal delay={0.45}>
            <p className="mt-6 max-w-[38ch] text-[18px] leading-[1.5] text-fg-2 lg:text-[19px]">
              Text Perry on Telegram. It remembers you, gets real work done on your own machine, and asks before it oversteps.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <a
                href="#install"
                className="inline-flex h-12 items-center rounded-full bg-fg px-6 text-[15.5px] font-medium text-canvas transition-colors hover:bg-white"
              >
                Run your own Perry
              </a>
              <a
                href="#memory"
                className="inline-flex h-12 items-center rounded-full border border-line-strong px-6 text-[15.5px] font-medium text-fg transition-colors hover:bg-white/5"
              >
                See what it does
              </a>
            </div>
            <p className="mt-6 font-mono text-[12.5px] text-fg-3">You run your own copy · macOS, Linux, Windows</p>
          </Reveal>
        </div>
        <HeroStage />
      </div>
    </section>
  );
}
