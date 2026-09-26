import type { ReactNode } from "react";
import { PlatypusArt } from "@/components/dashboard/platypus";
import { cn } from "@/lib/utils";

/** A tab with nothing in it yet: him, napping, and what would go here. */
export function Empty({ title, children, awake, className }: { title: string; children?: ReactNode; awake?: boolean; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center px-8 pt-6 pb-3 text-center", className)}>
      <PlatypusArt head asleep={!awake} hat={Boolean(awake)} className="size-12 rounded-full bg-brand-soft" />
      <p className="mt-3 text-[14px] font-semibold tracking-[-0.005em]">{title}</p>
      {children && <p className="mt-1 text-[12.5px] leading-relaxed text-pretty text-muted-foreground">{children}</p>}
    </div>
  );
}
