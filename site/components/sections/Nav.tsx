import { PlatypusHead } from "@/components/mascot/PlatypusHead";
import { REPO } from "@/lib/site";

const LINKS = [
  { href: "#memory", label: "Features" },
  { href: "#install", label: "Install" },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line-soft bg-canvas/75 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6">
        <a href="#top" className="group flex items-center gap-2.5 text-[17px] font-semibold tracking-[-0.01em] text-fg">
          <PlatypusHead className="size-8 transition-transform duration-200 group-hover:-rotate-[10deg]" />
          Perry
        </a>
        <nav aria-label="Sections" className="hidden items-center gap-8 text-[14.5px] text-fg-3 md:flex">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href} className="transition-colors hover:text-fg">
              {link.label}
            </a>
          ))}
          <a href={REPO} className="transition-colors hover:text-fg">GitHub</a>
        </nav>
        <a
          href="#install"
          className="inline-flex h-9 items-center rounded-full bg-brand px-4 text-[14px] font-semibold text-canvas transition-[filter] hover:brightness-110"
        >
          Recruit Perry
        </a>
      </div>
    </header>
  );
}
