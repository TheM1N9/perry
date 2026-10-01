"use client";

import type { ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * A button's name in words, on hover or focus, in the pet's window. The tip is
 * data-solid, as all that pops up there must be, since the window lets clicks
 * through everywhere else; and it keeps inside the window (404 by 620), which
 * is all the screen it has, flipping below or sliding along where there is no
 * room above.
 */
export function PetTip({ label, side = "top", children }: { label: string; side?: "top" | "bottom"; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent data-solid side={side} className="max-w-60 text-pretty">{label}</TooltipContent>
    </Tooltip>
  );
}
