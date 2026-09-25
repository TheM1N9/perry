import { Reveal } from "@/components/fx/Reveal";
import { Platypus } from "@/components/mascot/Platypus";
import { PlatypusHead } from "@/components/mascot/PlatypusHead";
import { INSTALL_GUIDE, REPO } from "@/lib/site";

export function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="relative overflow-hidden border-t border-line-soft py-28 md:py-36">
      <Reveal className="relative mx-auto flex max-w-[1200px] flex-col items-center px-6 text-center">
        <Platypus size="lg" greeting="Ready when you are." />
        <h2 id="cta-title" className="headline-gradient mt-10 max-w-[16ch] pb-1 text-[40px] font-[560] leading-[1.05] tracking-[-0.03em] md:text-[64px]">
          One message and he&apos;s on the case.
        </h2>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <a href={REPO} className="inline-flex h-12 items-center rounded-full bg-brand px-6 text-[15.5px] font-semibold text-canvas transition-[filter] hover:brightness-110">
            Recruit Perry
          </a>
          <a href={INSTALL_GUIDE} className="inline-flex h-12 items-center rounded-full border border-line-strong px-6 text-[15.5px] font-medium text-fg transition-colors hover:bg-white/5">
            Read the briefing
          </a>
        </div>
      </Reveal>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-line-soft">
      <div className="mx-auto flex max-w-[1200px] items-center justify-between gap-8 px-6 py-10">
        <div>
          <p className="flex items-center gap-2.5 font-semibold text-fg">
            <PlatypusHead className="size-7" />
            Perry
          </p>
          <p className="mt-3 flex items-center gap-2 font-mono text-[12.5px] text-fg-3">
            <span className="size-1.5 rounded-full bg-brand" aria-hidden />
            Running on your machine, not ours.
          </p>
        </div>
        <a className="text-[14px] text-fg-3 hover:text-fg" href={REPO}>GitHub</a>
      </div>
    </footer>
  );
}
