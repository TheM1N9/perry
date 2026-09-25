import type { ReactNode } from "react";

/** A desktop window: what is happening on your own computer. */
export function Window({
  title, children, className = "", bodyClassName = "",
}: { title: string; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <div className={`lit-border overflow-hidden rounded-[16px] bg-surface shadow-[0_30px_100px_-30px_rgb(0_0_0/0.9)] ${className}`}>
      <div className="flex h-10 items-center gap-2 border-b border-line bg-surface-2 px-4">
        <span aria-hidden className="flex gap-2">
          <span className="size-3 rounded-full bg-white/15" />
          <span className="size-3 rounded-full bg-white/15" />
          <span className="size-3 rounded-full bg-white/15" />
        </span>
        <span className="flex-1 truncate text-center font-mono text-[12px] text-fg-3">{title}</span>
        <span aria-hidden className="w-[52px]" />
      </div>
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}
