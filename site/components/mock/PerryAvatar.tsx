import { PlatypusHead } from "@/components/mascot/PlatypusHead";

/** Perry's avatar in the chat mockups: the mascot's face. */
export function PerryAvatar({ className = "" }: { className?: string }) {
  return <PlatypusHead className={className} />;
}
