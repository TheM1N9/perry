import { Reveal } from "@/components/fx/Reveal";
import { Spotlight } from "@/components/fx/Spotlight";
import { PerryAvatar, PerryGlyph } from "@/components/mock/PerryAvatar";
import { INSTALL_GUIDE, REPO } from "@/lib/site";

export function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="relative overflow-hidden border-t border-line-soft py-32 md:py-44">
      <Spotlight className="top-0 h-[480px]" />
      <Reveal className="relative mx-auto flex max-w-[1200px] flex-col items-center px-6 text-center">
        <PerryAvatar className="size-16 shadow-[0_0_60px_rgb(255_255_255/0.12)]" />
        <h2 id="cta-title" className="headline-gradient mt-8 max-w-[16ch] pb-1 text-[40px] font-[560] leading-[1.05] tracking-[-0.03em] md:text-[64px]">
          Get started with just a message.
        </h2>
        <p className="mt-5 max-w-[44ch] text-[17px] text-fg-3 md:text-[18px]">
          Clone it, run setup, and send your bot six digits. Perry takes it from there.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <a href={REPO} className="inline-flex h-12 items-center gap-2 rounded-full bg-fg px-6 text-[15.5px] font-medium text-canvas transition-colors hover:bg-white">
            Run your own Perry
          </a>
          <a href={INSTALL_GUIDE} className="inline-flex h-12 items-center rounded-full border border-line-strong px-6 text-[15.5px] font-medium text-fg transition-colors hover:bg-white/5">
            Read the install guide
          </a>
        </div>
      </Reveal>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-line-soft">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-8 px-6 py-12 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="flex items-center gap-2.5 font-semibold text-fg">
            <span className="grid size-6 place-items-center rounded-md bg-fg text-canvas"><PerryGlyph className="w-3.5" ink="#08090a" /></span>
            Perry
          </p>
          <p className="mt-3 flex items-center gap-2 font-mono text-[12.5px] text-fg-3">
            <span className="size-1.5 rounded-full bg-ok" aria-hidden />
            Running on your machine, not ours.
          </p>
        </div>
        <p className="max-w-[56ch] text-[13.5px] leading-relaxed text-fg-3">
          Built on <a className="text-fg-2 hover:text-fg" href="https://convex.dev">Convex</a>, the{" "}
          <a className="text-fg-2 hover:text-fg" href="https://github.com/openai/codex">Codex CLI</a> and{" "}
          <a className="text-fg-2 hover:text-fg" href="https://composio.dev">Composio</a>, and inspired by OpenClaw. Parts are adapted from Vercel&apos;s{" "}
          <a className="text-fg-2 hover:text-fg" href="https://github.com/vercel/eve">eve</a> under the Apache License 2.0. This page loads nothing from anyone else&apos;s server.{" "}
          <a className="text-fg-2 hover:text-fg" href={REPO}>Source on GitHub</a>
        </p>
      </div>
    </footer>
  );
}
