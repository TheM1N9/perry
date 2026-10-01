"use client";

import { AlarmClockIcon, FlameIcon, PlusIcon, RepeatIcon, SparklesIcon, XIcon } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useMutation } from "@/client/react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge, TextTip } from "@/components/dashboard/common";
import { api } from "@/convex/_generated/api";
import type { TodoView } from "@/convex/todos";
import { errorText } from "@/lib/format";
import { useDashboardKey } from "@/lib/session";
import { cn } from "@/lib/utils";
import { cronFor, describeSchedule, dueLabel, readTodo, REPEAT_NAMES, REPEATS, repeatLabel, repeatOf, type Repeat } from "@/lib/when";

/**
 * The to-do list's parts, shared by the desktop pet's panel and the
 * dashboard's To-dos page: the box you type into, and the rows.
 */

/** Type a to-do the way you would say it; what the time, and any repeat, was read as shows before it is added. */
export function QuickAdd({ onAdded, autoFocus, className }: { onAdded?: (title: string, dueAt?: number) => void; autoFocus?: boolean; className?: string }) {
  const key = useDashboardKey();
  const add = useMutation(api.todos.add);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const read = text.trim() ? readTodo(text) : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!read) return;
    // Cleared at once, so the next one can be typed while this one saves; put back if it does not.
    const typed = text;
    setText("");
    setError("");
    try {
      await add({ key, title: read.title, ...(read.dueAt ? { dueAt: read.dueAt } : {}), ...(read.repeat ? { repeat: read.repeat } : {}) });
      onAdded?.(read.title, read.dueAt);
    } catch (cause) {
      setText((now) => now || typed);
      setError(errorText(cause));
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className={className}>
      <InputGroup className="h-10 rounded-xl bg-card shadow-raised dark:bg-card">
        <InputGroupAddon><PlusIcon aria-hidden /></InputGroupAddon>
        <InputGroupInput
          value={text}
          onChange={(event) => { setText(event.target.value); setError(""); }}
          autoFocus={autoFocus}
          aria-label="Add a to-do"
          placeholder="Add a to-do: “call Sam 2pm”"
          className="md:text-sm"
        />
      </InputGroup>
      <div className="mt-1.5 flex min-h-5 items-center gap-1.5 px-0.5 text-xs text-muted-foreground" aria-live="polite">
        {error ? <span className="text-destructive">{error}</span>
          : read?.repeatName ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 font-medium text-foreground">
              <RepeatIcon className="size-3" aria-hidden />{read.repeatName}
            </span>
          ) : read?.dueAt ? (
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
    <TextTip tip="Days in a row with something done" spoken="in a row with something done" className="rounded-full">
      <StatusBadge tone="warning"><FlameIcon className="-mx-0.5 size-3.5" aria-hidden />{days} {days === 1 ? "day" : "days"}</StatusBadge>
    </TextTip>
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
            {/* Perry's checkbox, kept round: a to-do ticked off, not a setting. */}
            <Checkbox
              checked={done}
              aria-label={done ? `Put back “${todo.title}”` : `Done: “${todo.title}”`}
              onCheckedChange={() => {
                void setDone({ key, id: todo.id, done: !done }).catch(() => {});
                if (!done) onDone?.(todo);
              }}
              className="size-[18px] cursor-pointer rounded-full border-[1.5px] border-muted-foreground/45 hover:border-primary hover:bg-primary/10 data-checked:hover:bg-primary [&_[data-slot=checkbox-indicator]>svg]:size-3 [&_svg]:stroke-3"
            />
            <span className={cn("min-w-0 flex-1 truncate", compact ? "text-sm" : "text-md", done && "text-muted-foreground line-through")}>
              {todo.title}
            </span>
            {todo.by === "assistant" && <SparklesIcon className="size-3.5 shrink-0 text-primary" aria-label="Perry added this" />}
            {!done && <RepeatMenu todo={todo} />}
            {done && todo.repeat && <RepeatIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Repeats" />}
            {todo.dueAt !== undefined && !done && (
              <span className={cn("shrink-0 text-xs nums", late ? "font-semibold text-destructive" : soon ? "font-medium text-warning" : "text-muted-foreground")}>
                {dueLabel(todo.dueAt, now)}
              </span>
            )}
            <Button variant="ghost" size="icon-xs" aria-label={`Remove “${todo.title}”`} onClick={() => void remove({ key, id: todo.id }).catch(() => {})}
              className="text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100">
              <XIcon className="size-3.5" />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * How a to-do repeats, and a menu to change it: Daily, Weekdays, Weekly or
 * Monthly at its own time of day (9 in the morning if it has none), weekly on
 * its day and monthly on its date. A schedule Perry set in a chat that is none
 * of these shows as it reads, until one of these replaces it.
 */
function RepeatMenu({ todo }: { todo: TodoView }) {
  const key = useDashboardKey();
  const setRepeat = useMutation(api.todos.setRepeat);
  const current = repeatOf(todo.repeat);
  const change = (value: string) => {
    const at = todo.dueAt ? new Date(todo.dueAt) : new Date(new Date().setHours(9, 0, 0, 0));
    void setRepeat({ key, id: todo.id, repeat: value === "none" ? null : cronFor(value as Repeat, at) }).catch(() => {});
  };
  return (
    <DropdownMenu>
      {/* What the repeat is in full, in a tip; data-solid, as everything that pops up in the pet's window must be. */}
      <Tooltip>
        <TooltipTrigger
          render={<DropdownMenuTrigger aria-label={todo.repeat ? `Repeats ${repeatLabel(todo.repeat).toLowerCase()}: change` : `Make “${todo.title}” repeat`} />}
          className={cn(
            "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:opacity-100",
            todo.repeat ? "px-1.5" : "w-6 justify-center opacity-0 transition-opacity group-hover:opacity-100",
          )}
        >
          <RepeatIcon className="size-3.5" aria-hidden />
          {todo.repeat && repeatLabel(todo.repeat)}
        </TooltipTrigger>
        <TooltipContent data-solid>{todo.repeat ? (describeSchedule(todo.repeat) ?? todo.repeat) : "Repeat"}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-44" data-solid>
        <DropdownMenuRadioGroup value={current ?? (todo.repeat ? "other" : "none")} onValueChange={(value) => change(value as string)}>
          <DropdownMenuRadioItem value="none">Doesn’t repeat</DropdownMenuRadioItem>
          {REPEATS.map((repeat) => <DropdownMenuRadioItem key={repeat} value={repeat}>{REPEAT_NAMES[repeat]}</DropdownMenuRadioItem>)}
          {todo.repeat && !current && <DropdownMenuRadioItem value="other" disabled>{describeSchedule(todo.repeat) ?? todo.repeat}</DropdownMenuRadioItem>}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
