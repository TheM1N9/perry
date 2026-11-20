/**
 * Where something lives on the Board (components/dashboard/screens/board.tsx), as an address: its channel, the
 * thread open in it, the tab. The Board took over Work and Needs you, so their old addresses (and the anchors
 * Work used: #task-…, #job-…, #goal-…, #watch-…) come here too. No server imports: the backend's links and the
 * pages that redirect use it alike.
 */

export type BoardPlace = { channel?: string; thread?: string; tab?: string };

export function boardLink({ channel, thread, tab }: BoardPlace = {}): string {
  const query = new URLSearchParams();
  if (channel) query.set("channel", channel);
  if (tab) query.set("tab", tab);
  if (thread) query.set("thread", thread);
  const search = query.toString();
  return search ? `/board?${search}` : "/board";
}

/** The Board tab that holds what waits on the owner: what the Needs you page listed. */
export const NEEDS_YOU = "needs you";

const WORK_TABS: Record<string, string> = { plans: "tasks", schedules: "jobs", goals: "goals", watches: "watches" };
const ANCHORS: Record<string, string> = { task: "tasks", job: "jobs", goal: "goals", watch: "watches" };

/** Where an old Work address goes: its tab's channel, and the thread its anchor named. */
export function fromWork(tab: string | null, hash: string): string {
  const anchor = /^#(task|job|goal|watch)-(.+)$/.exec(hash);
  if (anchor) return boardLink({ channel: ANCHORS[anchor[1]], thread: `${anchor[1]}:${decodeURIComponent(anchor[2])}` });
  return boardLink({ channel: WORK_TABS[tab ?? ""] ?? "tasks" });
}
