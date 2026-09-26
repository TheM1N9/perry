import type { ChatStatus } from "@/convex/dashboard";
import { cn } from "@/lib/utils";

const LABEL: Record<ChatStatus, string> = {
  "needs-approval": "Waiting for your approval",
  running: "Working",
  error: "The last reply failed",
  idle: "",
};

/** What a chat is doing, as a dot: amber waits on you, teal works, red failed, a filled teal dot is a reply you haven't read. */
export function StatusDot({ status, unseen, className }: { status: ChatStatus; unseen?: boolean; className?: string }) {
  const label = status === "idle" ? (unseen ? "New reply" : "") : LABEL[status];
  if (!label) return null;
  return (
    <span role="img" aria-label={label} title={label} className={cn("relative flex size-2", className)}>
      {(status === "needs-approval" || status === "running") && (
        <span className={cn("absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping", status === "running" ? "bg-primary" : "bg-warning")} />
      )}
      <span className={cn("relative size-2 rounded-full",
        status === "needs-approval" ? "bg-warning" : status === "running" ? "bg-primary" : status === "error" ? "bg-destructive" : "bg-primary")} />
    </span>
  );
}
