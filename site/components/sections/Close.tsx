import { Reveal } from "@/components/fx/Reveal";
import { Platypus, PlatypusArt } from "@/components/mascot/Platypus";
import { INSTALL_GUIDE, REPO } from "@/lib/site";

export function Close() {
  return (
    <section aria-labelledby="close-title" className="bg-mist">
      <Reveal className="mx-auto flex max-w-[1180px] flex-col items-center px-6 py-28 text-center md:py-36">
        <Platypus greeting="Ready when you are." />
        <h2 id="close-title" className="mt-10 max-w-[14ch] text-[48px] font-[600] leading-[1] tracking-[-0.04em] md:text-[84px]">
          Tomorrow, 07:00. Want in?
        </h2>
        <a href="#setup" className="mt-10 inline-flex h-12 items-center rounded-full bg-teal px-7 text-[16px] font-semibold text-white transition-colors hover:bg-[#0a6a61]">
          Get Perry
        </a>
        <p className="mt-5 text-[15px] text-ink-3">Runs on macOS, Linux and Windows, on the ChatGPT plan you already have.</p>
      </Reveal>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-hair bg-mist">
      <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-6 px-6 py-8">
        <div className="flex items-center gap-3">
          <PlatypusArt asleep className="w-11" />
          <p className="text-[14px] text-ink-3">Off the clock. Your data stays put.</p>
        </div>
        <nav aria-label="Footer" className="flex gap-6 text-[14px] text-ink-3">
          <a href={INSTALL_GUIDE} className="hover:text-ink">Install guide</a>
          <a href={REPO} className="hover:text-ink">GitHub</a>
        </nav>
      </div>
    </footer>
  );
}
