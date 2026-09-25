/** Perry's avatar: a chat bubble with a prompt in it, for an assistant that talks and runs things. */
export function PerryAvatar({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden className={`grid shrink-0 place-items-center rounded-full bg-gradient-to-b from-[#f7f8f8] to-[#c9ced6] text-[#08090a] ${className}`}>
      <PerryGlyph className="w-[55%]" />
    </span>
  );
}

export function PerryGlyph({ className = "", ink = "#f7f8f8" }: { className?: string; ink?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5v-8Z" fill="currentColor" />
      <path d="m8.5 7.5 2.5 2-2.5 2M12.5 11.5h3" stroke={ink} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
