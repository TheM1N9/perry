"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { boardLink, fromWork, NEEDS_YOU } from "@/lib/board-links";

/**
 * Work and Needs you, now parts of the Board. Their addresses (bookmarks, links in old messages) go on to the
 * matching channel, thread or tab. The anchor (#job-…) only reaches the browser, so the move happens here.
 */
export function MovedToBoard({ from }: { from: "work" | "inbox" }) {
  const router = useRouter();
  const params = useSearchParams()!;
  useEffect(() => {
    router.replace(from === "inbox" ? boardLink({ tab: NEEDS_YOU }) : fromWork(params.get("tab"), window.location.hash));
  }, [from, params, router]);
  return null;
}
