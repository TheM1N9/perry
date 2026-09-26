import { PlatypusHead } from "@/components/mascot/PlatypusHead";
import { REPO } from "@/lib/site";

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-hair bg-white/80 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-[1180px] items-center justify-between px-6">
        <a href="#top" className="group flex items-center gap-2 text-[17px] font-semibold tracking-[-0.01em]">
          <PlatypusHead className="size-8 transition-transform duration-200 group-hover:-rotate-[10deg]" ring={false} />
          Perry
        </a>
        <nav aria-label="Sections" className="hidden items-center gap-8 text-[14px] text-ink-3 md:flex">
          <a href="#day" className="hover:text-ink">A day with Perry</a>
          <a href="#setup" className="hover:text-ink">Setup</a>
          <a href={REPO} className="hover:text-ink">GitHub</a>
        </nav>
        <a href="#setup" className="inline-flex h-8 items-center rounded-full bg-teal px-4 text-[14px] font-semibold text-white transition-colors hover:bg-[#0a6a61]">
          Get Perry
        </a>
      </div>
    </header>
  );
}
