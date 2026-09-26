"use client";

import { useEffect, useState } from "react";
import { PlatypusHead } from "@/components/mascot/PlatypusHead";

/** Perry and Get Perry. A full-width bar at the top of the page; once you scroll, a floating pill of frosted glass, 85% as wide. */
export function Nav() {
  const [pill, setPill] = useState(false);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setPill(window.scrollY > 24);
      // Over the night scene the glass goes dark, as glass does over a dark window.
      const night = document.getElementById("night")?.getBoundingClientRect();
      setDark(!!night && night.top < 60 && night.bottom > 12);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header data-pill={pill || undefined} data-dark={(pill && dark) || undefined} className="pointer-events-none sticky top-0 z-40 flex h-14 items-start">
      <div
        className={`pointer-events-auto mx-auto flex items-center justify-between transition-all duration-300 ease-out ${
          !pill
            ? "mt-0 h-14 w-full max-w-[1180px] rounded-none border border-transparent bg-white px-6 text-ink"
            : dark
              ? "mt-3 h-12 w-[85%] max-w-[1003px] rounded-full border border-white/15 bg-[#15181d]/55 pl-4 pr-1.5 text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_12px_32px_-12px_rgb(0_0_0/0.6)] backdrop-blur-2xl backdrop-saturate-[1.8]"
              : "mt-3 h-12 w-[85%] max-w-[1003px] rounded-full border border-white/70 bg-white/55 pl-4 pr-1.5 text-ink shadow-[inset_0_1px_0_rgb(255_255_255/0.8),0_0_0_1px_rgb(0_0_0/0.06),0_12px_32px_-12px_rgb(0_0_0/0.28)] backdrop-blur-2xl backdrop-saturate-[1.8]"
        }`}
      >
        <a href="#top" className="group flex items-center gap-2 text-[17px] font-semibold tracking-[-0.01em]">
          <PlatypusHead className="size-8 transition-transform duration-200 group-hover:-rotate-[10deg]" ring={false} />
          Perry
        </a>
        <a href="#setup" className="inline-flex h-9 items-center rounded-full bg-teal px-4 text-[14px] font-semibold text-white transition-colors hover:bg-[#0a6a61]">
          Get Perry
        </a>
      </div>
    </header>
  );
}
