"use client";

import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { useNow } from "@/lib/format";
import { useSession } from "@/lib/session";

/** Approvals still open, plus everything else waiting in Needs you. */
export function useNeedsYouCount(): number {
  const { dashboardKey } = useSession();
  const approvals = useQuery(api.approvals.pending, { key: dashboardKey });
  const inbox = useQuery(api.dashboard.getInbox, { key: dashboardKey });
  const now = useNow(15_000);
  return (approvals ?? []).filter((item) => item.expiresAt > now).length + (inbox?.length ?? 0);
}
