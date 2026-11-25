"use client";

import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { useSession } from "@/lib/session";

/** Decisions still waiting: approvals, task questions and native chat questions. */
export function useNeedsYouCount(): number {
  const { dashboardKey } = useSession();
  const approvals = useQuery(api.approvals.pendingCount, { key: dashboardKey });
  const inbox = useQuery(api.dashboard.getInbox, { key: dashboardKey });
  const questions = useQuery(api.questions.pendingCount, { key: dashboardKey });
  return (approvals ?? 0) + (inbox ?? []).filter(item => item.kind === "question").length + (questions ?? 0);
}
