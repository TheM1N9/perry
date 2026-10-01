"use client";

import type { ComponentProps } from "react";
import { trackEvent, type EventData, type EventName } from "@/lib/analytics";

/** A link that sends a custom event to Vercel Web Analytics when it's followed. */
export function TrackLink<E extends EventName>({ event, data, onClick, ...link }: ComponentProps<"a"> & { event: E; data: EventData<E> }) {
  return (
    <a
      {...link}
      onClick={(e) => {
        trackEvent(event, data);
        onClick?.(e);
      }}
    />
  );
}
