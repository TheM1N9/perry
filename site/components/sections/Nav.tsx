import { PerryGlyph } from "@/components/mock/PerryAvatar";
import { REPO } from "@/lib/site";

const LINKS = [
  { href: "#memory", label: "Features" },
  { href: "#privacy", label: "Privacy" },
  { href: "#install", label: "Install" },
  { href: "#faq", label: "FAQ" },
];

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line-soft bg-canvas/75 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between px-6">
        <a href="#top" className="flex items-center gap-2.5 text-[17px] font-semibold tracking-[-0.01em] text-fg">
          <span className="grid size-7 place-items-center rounded-lg bg-fg text-canvas">
            <PerryGlyph className="w-4" ink="#08090a" />
          </span>
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
          className="inline-flex h-9 items-center rounded-full bg-fg px-4 text-[14px] font-medium text-canvas transition-colors hover:bg-white"
        >
          Get Perry
        </a>
      </div>
    </header>
  );
}
