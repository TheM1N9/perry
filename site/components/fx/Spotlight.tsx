/** A faint pool of white light above a section; never coloured. */
export function Spotlight({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute left-1/2 h-[360px] w-[min(900px,100%)] -translate-x-1/2 bg-[radial-gradient(50%_50%_at_50%_50%,rgb(255_255_255/0.07),transparent)] ${className}`}
    />
  );
}
