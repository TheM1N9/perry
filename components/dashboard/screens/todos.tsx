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
      description="What you mean to do. Give one a time and you're reminded then, by Perry on your screen or on your phone when you're away, until it's done."
      actions={board ? <StreakBadge days={board.streak} /> : undefined}
    >
      <QuickAdd className="mb-6" />
      {board === undefined ? <ListSkeleton />
        : board.open.length === 0 ? (
          <EmptyState title="Nothing to do" mascot>
            Type one above, or tell Perry in any chat: “remind me to call Sam at 2”.
          </EmptyState>
        ) : <div className="rounded-xl border bg-card p-1.5"><TodoRows todos={board.open} now={now} /></div>}
      {board && board.doneToday.length > 0 && (
        <Section title="Done today" className="mt-8">
          <div className="rounded-xl border bg-card p-1.5"><TodoRows todos={board.doneToday} now={now} /></div>
        </Section>
      )}
    </Page>
  );
}
