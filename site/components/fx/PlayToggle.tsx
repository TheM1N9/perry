"use client";

/** Pause or resume a demo that plays by itself. */
export function PlayToggle({ paused, onToggle, label, className = "" }: { paused: boolean; onToggle: () => void; label: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={paused}
      aria-label={`${paused ? "Play" : "Pause"} ${label}`}
      className={`grid size-8 place-items-center rounded-full border border-line-strong bg-surface-2/80 text-fg-2 backdrop-blur transition-colors hover:text-fg ${className}`}
    >
      {paused ? (
        <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.8v8.4a.6.6 0 0 0 .9.5l7-4.2a.6.6 0 0 0 0-1L3.9 1.3a.6.6 0 0 0-.9.5Z" /></svg>
      ) : (
        <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2.5" y="1.5" width="2.6" height="9" rx=".7" /><rect x="6.9" y="1.5" width="2.6" height="9" rx=".7" /></svg>
      )}
    </button>
  );
}
