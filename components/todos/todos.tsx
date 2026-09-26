"use client";

import { AlarmClockIcon, CheckIcon, FlameIcon, RepeatIcon, SparklesIcon, XIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useMutation } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { TodoView } from "@/convex/todos";
import { errorText } from "@/lib/format";
import { useDashboardKey } from "@/lib/session";
import { cn } from "@/lib/utils";
import { dueLabel, readTodo } from "@/lib/when";

/**
 * The to-do list's parts, shared by the desktop pet's panel and the
 * dashboard's To-dos page: the box you type into, and the rows.
 */

/** Type a to-do the way you would say it; what the time was read as shows before it is added. */
export function QuickAdd({ onAdded, autoFocus, className }: { onAdded?: (title: string, dueAt?: number) => void; autoFocus?: boolean; className?: string }) {
  const key = useDashboardKey();
  const add = useMutation(api.todos.add);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const read = text.trim() ? readTodo(text) : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!read) return;
    try {
      await add({ key, title: read.title, ...(read.dueAt ? { dueAt: read.dueAt } : {}) });
      setText("");
      setError("");
      onAdded?.(read.title, read.dueAt);
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className={className}>
      <input
        value={text}
        onChange={(event) => { setText(event.target.value); setError(""); }}
        autoFocus={autoFocus}
        aria-label="Add a to-do"
        placeholder="Add a to-do: “call Sam 2pm”"
        className="h-9 w-full rounded-lg border bg-background px-3 text-[14px] outline-none placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
      />
      <div className="mt-1.5 flex min-h-5 items-center gap-1.5 px-0.5 text-[12px] text-muted-foreground" aria-live="polite">
        {error ? <span className="text-destructive">{error}</span>
          : read?.dueAt ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 font-medium text-foreground">
              <AlarmClockIcon className="size-3" aria-hidden />{dueLabel(read.dueAt)}
            </span>
          ) : read ? <span>No time · Enter to add</span> : null}
        {read?.dueAt && <span className="truncate">“{read.title}”</span>}
      </div>
    </form>
  );
}

export function StreakBadge({ days }: { days: number }) {
  if (!days) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-warning/12 px-2 py-0.5 text-[12px] font-semibold text-warning" title="Days in a row with something done">
      <FlameIcon className="size-3.5" aria-hidden />{days} {days === 1 ? "day" : "days"}
    </span>
  );
}

export function TodoRows({ todos, now, compact, onDone }: { todos: TodoView[]; now: number; compact?: boolean; onDone?: (todo: TodoView) => void }) {
  const key = useDashboardKey();
  const setDone = useMutation(api.todos.setDone);
  const remove = useMutation(api.todos.remove);
  return (
    <ul className="flex flex-col" aria-label="To-dos">
      {todos.map((todo) => {
        const done = Boolean(todo.doneAt);
        const late = !done && todo.dueAt !== undefined && todo.dueAt <= now;
        const soon = !done && todo.dueAt !== undefined && !late && todo.dueAt - now < 3_600_000;
        return (
          <li key={todo.id} className={cn("group flex items-center gap-2.5 rounded-lg", compact ? "px-1.5 py-1.5" : "px-2 py-2.5", "hover:bg-muted/60")}>
            <button
              type="button"
              role="checkbox"
              aria-checked={done}
              aria-label={done ? `Put back “${todo.title}”` : `Done: “${todo.title}”`}
              onClick={() => {
                void setDone({ key, id: todo.id, done: !done }).catch(() => {});
                if (!done) onDone?.(todo);
              }}
              className={cn(
                "grid size-[18px] shrink-0 cursor-pointer place-items-center rounded-full border-[1.5px] transition-colors",
                done ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/45 hover:border-primary hover:bg-primary/10",
              )}
            >
              {done && <CheckIcon className="size-3" strokeWidth={3} aria-hidden />}
            </button>
            <span className={cn("min-w-0 flex-1 truncate", compact ? "text-[13.5px]" : "text-[14.5px]", done && "text-muted-foreground line-through")}>
              {todo.title}
            </span>
            {todo.by === "assistant" && <SparklesIcon className="size-3.5 shrink-0 text-primary" aria-label="Perry added this" />}
            {todo.repeat && <RepeatIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Repeats" />}
            {todo.dueAt !== undefined && !done && (
              <span className={cn("shrink-0 text-[12px] nums", late ? "font-semibold text-destructive" : soon ? "font-medium text-warning" : "text-muted-foreground")}>
                {dueLabel(todo.dueAt, now)}
              </span>
            )}
            <button
              type="button"
              aria-label={`Remove “${todo.title}”`}
              onClick={() => void remove({ key, id: todo.id }).catch(() => {})}
              className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            >
              <XIcon className="size-3.5" aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
