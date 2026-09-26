import { PlatypusArt } from "./Platypus";

/** Perry's face, for the logo and the chat avatar. */
export function PlatypusHead({ className = "", ring = true }: { className?: string; ring?: boolean }) {
  return (
    <span aria-hidden className={`grid shrink-0 place-items-center overflow-hidden rounded-full ${ring ? "bg-teal-soft" : ""} ${className}`}>
      <PlatypusArt head className="w-[92%] translate-y-[6%]" />
    </span>
  );
}
