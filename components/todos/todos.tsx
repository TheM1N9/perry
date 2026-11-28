"use client";

import { toast } from "sonner";
import { AlarmClockIcon, FlameIcon, PlusIcon, RepeatIcon, SparklesIcon, XIcon } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useMutation } from "@/client/react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { StatusBadge, TextTip } from "@/components/dashboard/common";
import { api } from "@/convex/_generated/api";
import type { Board, TodoView } from "@/convex/todos";
import type { Id } from "@/convex/_generated/dataModel";
import { errorText } from "@/lib/format";
import { useDashboardKey } from "@/lib/session";
import { cn } from "@/lib/utils";
import { randomUUID } from "@/lib/uuid";
import { cronFor, describeSchedule, dueLabel, readTodo, REPEAT_NAMES, REPEATS, repeatLabel, repeatOf, type Repeat } from "@/lib/when";

/**
 * The to-do list's parts, shared by the desktop pet's panel and the
 * dashboard's To-dos page: the box you type into, and the rows.
 */

type TodoDraft = { text: string; literal: boolean };
type TodoFailure = { id: string; draft: TodoDraft; error: string };
const PENDING_TODO = "pending-todo:";
const pendingTodo = (todo: Omit<TodoView, "id" | "createdAt">): TodoView => ({ ...todo, id: `${PENDING_TODO}${randomUUID()}` as Id<"todos">, createdAt: Date.now() });
const byDue = (a: TodoView, b: TodoView) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.createdAt - b.createdAt;
const withTodo = (board: Board, todo: TodoView): Board => todo.doneAt
  ? { ...board, doneToday: [...board.doneToday, todo].sort((a, b) => b.doneAt! - a.doneAt!) }
  : { ...board, open: [...board.open, todo].sort(byDue) };

/** Type a to-do the way you would say it; what the time, and any repeat, was read as shows before it is added. */
export function QuickAdd({ onAdded, autoFocus, className }: { onAdded?: (title: string, dueAt?: number) => void; autoFocus?: boolean; className?: string }) {
  const key = useDashboardKey();
  const add = useMutation(api.todos.add);
  const [draft, setDraft] = useState<TodoDraft>({ text: "", literal: false });
  const { text, literal } = draft;
  const [saving, setSaving] = useState(false);
  const [failures, setFailures] = useState<TodoFailure[]>([]);
  const flight = useRef(false);
  const read: ReturnType<typeof readTodo> | null = text.trim() ? literal ? { title: text.trim() } : readTodo(text) : null;

  const submitDraft = async (submitted: TodoDraft, retry?: TodoFailure) => {
    const read = submitted.text.trim() ? submitted.literal ? { title: submitted.text.trim() } : readTodo(submitted.text) : null;
    if (!read || flight.current) return;
    flight.current = true;
    setSaving(true);
    setDraft((current) => current === submitted ? { text: "", literal: false } : current);
    const todo = pendingTodo({ title: read.title.replace(/\s+/g, " ").trim().slice(0, 200), by: "owner", dueAt: read.dueAt, repeat: read.repeat });
    const failureId = (retry ?? failures.find((failure) => failure.draft === submitted))?.id ?? todo.id;
    let loaded: boolean | undefined;
    try {
      await add.withOptimisticUpdate((store, args) => {
        const board = store.getQuery(api.todos.board, { key: args.key });
        loaded ??= board !== undefined;
        if (!loaded || !board) return;
        store.setQuery(api.todos.board, { key: args.key }, withTodo(board, todo));
      })({ key, title: read.title, ...(read.dueAt ? { dueAt: read.dueAt } : {}), ...(read.repeat ? { repeat: read.repeat } : {}) });
      setFailures((current) => current.filter((failure) => failure.id !== failureId));
      if (onAdded) onAdded(read.title, read.dueAt);
      else toast.success(`Added “${read.title}”`);
    } catch (cause) {
      setFailures((current) => [...current.filter((failure) => failure.id !== failureId), { id: failureId, draft: submitted, error: errorText(cause) }]);
      setDraft((current) => current.text.trim() ? current : submitted);
    } finally { flight.current = false; setSaving(false); }
  };
  const submit = (event: FormEvent) => { event.preventDefault(); void submitDraft(draft); };

  return (
    <form onSubmit={(event) => void submit(event)} className={className} aria-busy={saving || undefined}>
      <InputGroup className="h-10 rounded-xl bg-card shadow-raised pointer-coarse:h-12 dark:bg-card">
        <InputGroupAddon><PlusIcon aria-hidden /></InputGroupAddon>
        <InputGroupInput
          value={text}
          onChange={(event) => setDraft({ text: event.target.value, literal: false })}
          autoFocus={autoFocus}
          aria-label="Add a to-do"
          placeholder="Add a to-do: “call Sam 2pm”"
          className="md:text-sm"
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton type="submit" size="sm" variant="secondary" disabled={!read || saving} aria-label="Add to-do" className="min-w-11 pointer-coarse:min-h-11">Add</InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <div className="mt-1.5 flex min-h-5 flex-wrap items-center gap-x-1.5 gap-y-1 px-0.5 text-xs text-muted-foreground" aria-live="polite">
        {read?.repeatName ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 font-medium text-foreground">
              <RepeatIcon className="size-3" aria-hidden />{read.repeatName}
            </span>
          ) : read?.dueAt ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 font-medium text-foreground">
              <AlarmClockIcon className="size-3" aria-hidden />{dueLabel(read.dueAt)}
            </span>
          ) : read ? <span>{literal ? "Text only" : "No time"} · Enter to add</span> : null}
        {read?.dueAt && <span className="truncate">“{read.title}”</span>}
        {read?.dueAt && <Button type="button" variant="ghost" size="xs" className="shrink-0 text-muted-foreground pointer-coarse:min-h-11" onClick={() => setDraft((now) => ({ ...now, literal: true }))}>Use text only</Button>}
      </div>
      {failures.map((failure) => <p key={failure.id} role="alert" className="mt-2 text-sm text-destructive [overflow-wrap:anywhere]">Couldn&apos;t add “{failure.draft.text}”: {failure.error}{" "}<Button type="button" variant="link" size="xs" aria-label={`Try again to add “${failure.draft.text}”`} disabled={saving} onClick={() => void submitDraft(failure.draft, failure)}>Try again</Button><Button type="button" variant="ghost" size="icon-xs" aria-label={`Dismiss failed to-do “${failure.draft.text}”`} onClick={() => setFailures((current) => current.filter((item) => item.id !== failure.id))}><XIcon /></Button></p>)}
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

export function TodoRows({ todos, now, compact, onDone, onRemoved, onProblem }: {
  todos: TodoView[]; now: number; compact?: boolean; onDone?: (todo: TodoView) => void;
  /** A to-do was removed, with a way to bring it back. Without this, a toast offers that. */
  onRemoved?: (todo: TodoView, undo: () => void) => void;
  /** Something did not go through. Without this, a toast says so. */
  onProblem?: (message: string) => void;
}) {
  const key = useDashboardKey();
  const setDone = useMutation(api.todos.setDone);
  const remove = useMutation(api.todos.remove).withOptimisticUpdate((store, args) => {
    const board = store.getQuery(api.todos.board, { key: args.key });
    if (board) store.setQuery(api.todos.board, { key: args.key }, { ...board, open: board.open.filter((row) => row.id !== args.id), doneToday: board.doneToday.filter((row) => row.id !== args.id) });
  });
  const restore = useMutation(api.todos.restore);
  const fail = (cause: unknown) => { if (onProblem) onProblem(errorText(cause)); else toast.error(errorText(cause)); };
  const changeDone = (id: TodoView["id"], done: boolean) => {
    const doneAt = Date.now();
    return setDone.withOptimisticUpdate((store, args) => {
      const board = store.getQuery(api.todos.board, { key: args.key });
      const todo = board && [...board.open, ...board.doneToday].find((row) => row.id === args.id);
      if (!board || !todo) return;
      const next = { ...board, open: board.open.filter((row) => row.id !== args.id), doneToday: board.doneToday.filter((row) => row.id !== args.id) };
      store.setQuery(api.todos.board, { key: args.key }, withTodo(next, { ...todo, doneAt: args.done ? todo.doneAt ?? doneAt : undefined }));
    })({ key, id, done });
  };
  const removeTodo = (todo: TodoView) => void remove({ key, id: todo.id }).then(() => {
    const undo = () => {
      const restored = pendingTodo({ title: todo.title, by: todo.by, dueAt: todo.dueAt, repeat: todo.repeat, doneAt: todo.doneAt });
      let loaded: boolean | undefined;
      void restore.withOptimisticUpdate((store, args) => {
        const board = store.getQuery(api.todos.board, { key: args.key });
        loaded ??= board !== undefined;
        if (!loaded || !board) return;
        store.setQuery(api.todos.board, { key: args.key }, withTodo(board, restored));
      })({ key, title: todo.title, by: todo.by, ...(todo.dueAt !== undefined ? { dueAt: todo.dueAt } : {}), ...(todo.repeat ? { repeat: todo.repeat } : {}), ...(todo.doneAt ? { doneAt: todo.doneAt } : {}) }).catch(fail);
    };
    if (onRemoved) onRemoved(todo, undo);
    else toast(`Removed “${todo.title}”`, { action: { label: "Undo", onClick: undo } });
  }, fail);
  return (
    <ul className="flex flex-col" aria-label="To-dos">
      {todos.map((todo) => {
        const pending = todo.id.startsWith(PENDING_TODO);
        const done = Boolean(todo.doneAt);
        const late = !done && todo.dueAt !== undefined && todo.dueAt <= now;
        const soon = !done && todo.dueAt !== undefined && !late && todo.dueAt - now < 3_600_000;
        return (
          <li key={todo.id} className={cn("group flex items-center gap-2.5 rounded-lg", compact ? "px-1.5 py-1.5" : "px-2 py-2.5", "hover:bg-muted/60 pointer-coarse:min-h-12 pointer-coarse:gap-4 pointer-coarse:pl-4")}>
            {/* Perry's checkbox, kept round: a to-do ticked off, not a setting. */}
            <Checkbox
              checked={done}
              disabled={pending}
              aria-label={done ? `Put back “${todo.title}”` : `Done: “${todo.title}”`}
              onCheckedChange={() => {
                if (pending) return;
                void changeDone(todo.id, !done).then(() => {
                  if (done) return;
                  if (onDone) onDone(todo);
                  else toast.success(`Completed “${todo.title}”`, {
                    id: `todo-completed:${todo.id}`,
                    ...(todo.repeat ? { description: "Its next occurrence is on your list." } : {
                      action: { label: "Undo", onClick: () => { void changeDone(todo.id, false).catch(fail); } },
                    }),
                  });
                }).catch(fail);
              }}
              className="size-[18px] cursor-pointer rounded-full border-[1.5px] border-muted-foreground/45 hover:border-primary hover:bg-primary/10 data-checked:hover:bg-primary [&_[data-slot=checkbox-indicator]>svg]:size-3 [&_svg]:stroke-3"
            />
            <span className={cn("min-w-0 flex-1 truncate", compact ? "text-sm" : "text-md", done && "text-muted-foreground line-through")}>
              {todo.title}
            </span>
            {todo.by === "assistant" && <SparklesIcon className="size-3.5 shrink-0 text-primary" aria-label="Perry added this" />}
            {!done && !pending && <RepeatMenu todo={todo} />}
            {(done || pending) && todo.repeat && <RepeatIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Repeats" />}
            {todo.dueAt !== undefined && !done && (
              <span className={cn("shrink-0 text-xs nums", late ? "font-semibold text-destructive" : soon ? "font-medium text-warning" : "text-muted-foreground")}>
                {dueLabel(todo.dueAt, now)}
              </span>
            )}
            <Button variant="ghost" size="icon-xs" disabled={pending} aria-label={`Remove “${todo.title}”`} onClick={() => { if (!pending) removeTodo(todo); }}
              className="text-muted-foreground opacity-0 pointer-coarse:opacity-100 focus-visible:opacity-100 group-hover:opacity-100">
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
  const setRepeat = useMutation(api.todos.setRepeat).withOptimisticUpdate((store, args) => {
    const board = store.getQuery(api.todos.board, { key: args.key });
    if (!board) return;
    const change = (row: TodoView) => row.id === args.id ? { ...row, repeat: args.repeat ?? undefined } : row;
    store.setQuery(api.todos.board, { key: args.key }, { ...board, open: board.open.map(change), doneToday: board.doneToday.map(change) });
  });
  const current = repeatOf(todo.repeat);
  const change = (value: string) => {
    const at = todo.dueAt ? new Date(todo.dueAt) : new Date(new Date().setHours(9, 0, 0, 0));
    void setRepeat({ key, id: todo.id, repeat: value === "none" ? null : cronFor(value as Repeat, at) }).catch((cause) => toast.error(`Couldn't change the repeat: ${errorText(cause)}`));
  };
  return (
    <DropdownMenu>
      {/* What the repeat is in full, in a tip; data-solid, as everything that pops up in the pet's window must be. */}
      <Tooltip>
        <TooltipTrigger
          render={<DropdownMenuTrigger aria-label={todo.repeat ? `Repeats ${repeatLabel(todo.repeat).toLowerCase()}: change` : `Make “${todo.title}” repeat`} />}
          className={cn(
            "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 data-popup-open:opacity-100 pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:opacity-100",
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
