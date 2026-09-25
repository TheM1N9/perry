import type { ReactNode } from "react";
import { Reveal } from "./Reveal";

/**
 * A chapter: a numbered label, a two-tone heading (the lead bright, the rest
 * quiet), a short intro beside it, then its stage.
 */
export function Section({
  id, index, label, lead, rest, intro, children, className = "",
}: {
  id: string; index?: string; label?: string; lead: string; rest?: string; intro?: ReactNode; children?: ReactNode; className?: string;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={`relative scroll-mt-16 py-24 md:py-28 ${className}`}>
      <div className="relative mx-auto max-w-[1200px] px-6">
        <Reveal className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,400px)] lg:items-end lg:gap-16">
          <div>
            {label ? (
              <p className="mb-5 font-mono text-[13px] text-fg-3">
                {index ? <span className="text-brand">case {index} · </span> : null}
                {label}
              </p>
            ) : null}
            <h2 id={`${id}-title`} className="max-w-[20ch] text-[34px] font-[560] leading-[1.08] tracking-[-0.025em] md:text-[48px]">
              <span className="text-fg">{lead}</span>
              {rest ? <span className="text-fg-3"> {rest}</span> : null}
            </h2>
          </div>
          {intro ? <p className="max-w-[46ch] text-[16.5px] leading-relaxed text-fg-3 lg:pb-1.5">{intro}</p> : null}
        </Reveal>
        {children}
      </div>
    </section>
  );
}
