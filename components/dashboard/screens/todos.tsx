"use client";

import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { useNow } from "@/lib/format";
import { useSession } from "@/lib/session";
import { QuickAdd, StreakBadge, TodoRows } from "@/components/todos/todos";
import { EmptyState, ListSkeleton, Page, Section } from "../common";

/**
 * Your own to-do list, the one the desktop pet keeps on screen. What Perry
 * adds from a chat shows up here too, marked with a sparkle.
 */
export function Todos() {
  const { dashboardKey } = useSession();
  const board = useQuery(api.todos.board, { key: dashboardKey });
  const now = useNow(15_000);

  return (
    <Page
      title="To-dos"
      description="Timed ones remind you on screen, or on your phone when you're away."
      actions={board ? <StreakBadge days={board.streak} /> : undefined}
    >
      <QuickAdd className="mb-6" />
      {board === undefined ? <ListSkeleton />
        : board.open.length === 0 ? (
          <EmptyState title="Nothing to do" mascot />
        ) : <div className="-mx-2"><TodoRows todos={board.open} now={now} /></div>}
      {board && board.doneToday.length > 0 && (
        <Section title="Done today" className="mt-8">
          <div className="-mx-2"><TodoRows todos={board.doneToday} now={now} /></div>
        </Section>
      )}
    </Page>
  );
}
