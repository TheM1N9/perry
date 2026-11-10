"use client";

import { ArrowUpIcon, ChevronDownIcon, GripVerticalIcon, PencilIcon, XIcon } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useMutation } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { QueuedTurn } from "@/convex/dashboard";
import { errorText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AttachmentList, type Attachment } from "./attachments";

/** A message waiting its turn: the server's (`queued`), or one just sent with Queue that it has not listed yet. */
export type UpNextItem = { key: string; text: string; attachments: Attachment[]; queued?: QueuedTurn };

/** A longer queue shows its first messages and a way to show the rest. */
const VISIBLE = 3;
/** Only a drag that began on a row's grip carries this, so dragging its text selects it instead. */
const DRAG_TYPE = "application/x-perry-queued";

/**
 * The messages sent with Queue, on top of the composer they came from, in the
 * order they will go (queue.ts, queuePosition), so they stay in sight wherever
 * the chat is scrolled. Each is a dashed, unfilled bubble, not sent yet, under
 * it Send now (into the reply running when it can join it, else to the front),
 * Edit (in the composer) and Remove, and a grip to drag it by or move it with
 * the arrow keys. After T3 Code's QueuedRunsControl (its row from PR 25846).
 */
export function UpNext({ items, editing, onEdit, onCancelEdit }: {
  items: UpNextItem[];
  /** The queued message being edited in the composer. */
  editing: Id<"codexTurns"> | null;
  onEdit: (item: UpNextItem & { queued: QueuedTurn }) => void;
  onCancelEdit: () => void;
}) {
  const { dashboardKey } = useSession();
  const remove = useMutation(api.queue.remove);
  const steer = useMutation(api.queue.steer);
  const sendNow = useMutation(api.queue.sendNow);
  const reorder = useMutation(api.queue.reorder);
  const listId = useId();
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [drag, setDrag] = useState<{ key: string; at: number | null } | null>(null);
  const armed = useRef<string | null>(null);
  // A message moved with the arrow keys keeps the focus on its grip, wherever React puts its row.
  const keepFocus = useRef<string | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const order = items.map((item) => item.key).join(",");
  useLayoutEffect(() => {
    if (!keepFocus.current) return;
    const grip = list.current?.querySelector<HTMLElement>(`[data-queued="${CSS.escape(keepFocus.current)}"] [data-grip]`);
    keepFocus.current = null;
    if (grip && document.activeElement !== grip) grip.focus();
  }, [order]);

  const server = items.filter((item): item is UpNextItem & { queued: QueuedTurn } => item.queued !== undefined);
  if (items.length === 0) return null;

  async function act(item: UpNextItem & { queued: QueuedTurn }, run: () => Promise<boolean>) {
    setBusy(item.key); setNotice("");
    try {
      if (!await run()) { keepFocus.current = null; setNotice("That message has already started or left the queue."); }
    } catch (error) {
      keepFocus.current = null;
      setNotice(errorText(error));
    } finally {
      setBusy(null);
    }
  }
  const ids = (item: UpNextItem & { queued: QueuedTurn }) => ({ key: dashboardKey, conversationId: item.queued.conversationId, id: item.queued.id });
  /** Put a message before the one now at `index` of the server's queue (its end, past the last). */
  function move(item: UpNextItem & { queued: QueuedTurn }, index: number) {
    const from = server.indexOf(item);
    if (from < 0 || index === from || index === from + 1) return;
    const next = server.filter((other) => other !== item);
    next.splice(index > from ? index - 1 : index, 0, item);
    void act(item, () => reorder({ key: dashboardKey, conversationId: item.queued.conversationId, ids: next.map((other) => other.queued.id) }));
  }

  const collapsible = items.length > VISIBLE;
  const shown = collapsible && !showAll ? items.slice(0, VISIBLE - 1) : items;
  return (
    // A long queue scrolls within itself, so the chat above keeps its room.
    <section aria-label={`Up next: ${items.length} queued message${items.length === 1 ? "" : "s"}`} data-up-next
      className="mb-2 flex max-h-[min(40vh,22rem)] flex-col gap-1 overflow-y-auto px-1 pt-1 [scrollbar-width:thin]">
      <p className="sr-only" aria-live="polite">{items.length} queued</p>
      <ol ref={list} id={listId} className="flex flex-col items-end gap-2">
        {shown.map((item, position) => {
          const queued = item.queued;
          const index = queued ? server.indexOf(item as UpNextItem & { queued: QueuedTurn }) : -1;
          const own = queued ? item as UpNextItem & { queued: QueuedTurn } : null;
          const isEditing = queued !== undefined && queued.id === editing;
          const locked = busy !== null || !queued;
          const movable = own !== null && server.length > 1;
          return (
            <li key={item.key} data-queued={item.key} aria-label={`Queued message ${position + 1} of ${items.length}, not sent`}
              aria-posinset={position + 1} aria-setsize={items.length} aria-current={isEditing || undefined}
              className={cn("group/queued relative flex w-full flex-col items-end gap-1 transition-opacity duration-150 starting:opacity-0 motion-reduce:transition-none", drag?.key === item.key && "opacity-50")}
              draggable={movable && !locked}
              onDragStart={(event) => {
                if (armed.current !== item.key) { event.preventDefault(); return; }
                event.dataTransfer.setData(DRAG_TYPE, item.key);
                event.dataTransfer.effectAllowed = "move";
                setDrag({ key: item.key, at: null });
              }}
              onDragEnd={() => { armed.current = null; setDrag(null); }}
              onDragOver={(event) => {
                if (!drag || index < 0) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const box = event.currentTarget.getBoundingClientRect();
                const at = event.clientY < box.top + box.height / 2 ? index : index + 1;
                if (drag.at !== at) setDrag({ key: drag.key, at });
              }}
              onDrop={(event) => {
                if (!drag) return;
                event.preventDefault();
                const dragged = server.find((other) => other.key === drag.key);
                armed.current = null;
                setDrag(null);
                if (dragged && drag.at !== null) move(dragged, drag.at);
              }}>
              {drag && index >= 0 && drag.at === index && <span aria-hidden className="pointer-events-none absolute inset-x-0 -top-1.5 h-0.5 rounded bg-primary/70" />}
              {drag && index === server.length - 1 && drag.at === server.length && <span aria-hidden className="pointer-events-none absolute inset-x-0 -bottom-1.5 h-0.5 rounded bg-primary/70" />}
              {/* Dashed and unfilled: a message that has not been sent yet. */}
              <div className={cn("flex max-w-[85%] min-w-0 flex-col gap-2 rounded-3xl border border-dashed px-4 py-2.5 text-md",
                isEditing ? "border-primary/60 text-foreground" : "border-muted-foreground/40 text-muted-foreground")}>
                {item.attachments.length > 0 && <AttachmentList attachments={item.attachments} align="end" compact />}
                {item.text && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{item.text}</p>}
              </div>
              <div className="flex items-center gap-0.5 pe-1 text-xs text-muted-foreground">
                {movable ? (
                  <Button type="button" size="icon-xs" variant="ghost" data-grip className="group/grip cursor-grab active:cursor-grabbing"
                    aria-label={`Move queued message ${position + 1} of ${items.length} (drag, or press the arrow keys)`}
                    // Not `disabled`, which would drop the focus between two presses of an arrow key.
                    aria-disabled={locked || undefined}
                    onPointerDown={() => { if (!locked) armed.current = item.key; }}
                    onKeyDown={(event) => {
                      if (locked || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                      event.preventDefault();
                      if (event.key === "ArrowUp" && index > 0) { keepFocus.current = item.key; move(own, index - 1); }
                      if (event.key === "ArrowDown" && index < server.length - 1) {
                        // Moving into the hidden rows would take the focused grip away.
                        if (index + 1 >= shown.length) setShowAll(true);
                        keepFocus.current = item.key;
                        move(own, index + 2);
                      }
                    }}>
                    <GripVerticalIcon className="opacity-0 transition-opacity group-hover/queued:opacity-100 group-focus-visible/grip:opacity-100 [@media(hover:none)]:opacity-100" />
                  </Button>
                ) : null}
                {!own ? <span className="px-1" role="status">Sending…</span> : isEditing ? <>
                  <span className="px-1 text-foreground">Editing in the composer</span>
                  <span aria-hidden>·</span>
                  <Button type="button" size="xs" variant="ghost" aria-label="Cancel editing the queued message" onClick={onCancelEdit}>Cancel</Button>
                </> : <>
                  <Tooltip>
                    <TooltipTrigger render={<span className="flex shrink-0" />}>
                      <Button type="button" size="xs" variant="ghost" disabled={locked || own.queued.retry || (own.queued.action === "send" && own.queued.held)} data-queue-action={own.queued.action}
                        onClick={() => void act(own, () => own.queued.action === "steer" ? steer(ids(own)) : sendNow(ids(own)))}>
                        <ArrowUpIcon />Send now
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{own.queued.action === "steer" ? "Add it to the reply that is running"
                      : own.queued.held ? "It waits for the usage limit to reset" : "Start it next, before the rest of the queue"}</TooltipContent>
                  </Tooltip>
                  <span aria-hidden className="mx-1 h-3.5 w-px bg-border" />
                  <Tooltip>
                    {/* The span keeps the tooltip, and why, on a button that is off. */}
                    <TooltipTrigger render={<span className="flex shrink-0" />}>
                      <Button type="button" size="icon-xs" variant="ghost" aria-label="Edit the queued message" disabled={locked || editing !== null || own.queued.preparing || own.queued.retry}
                        onClick={() => onEdit(own)}><PencilIcon /></Button>
                    </TooltipTrigger>
                    <TooltipContent>{own.queued.retry ? "Another engine's try at an earlier message keeps its words" : own.queued.preparing ? "Still being prepared" : editing !== null ? "Finish the other edit first" : "Edit in the composer"}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger render={<Button type="button" size="icon-xs" variant="ghost" aria-label="Remove the queued message" disabled={locked}
                      onClick={() => void act(own, () => remove(ids(own)))} />}>
                      <XIcon />
                    </TooltipTrigger>
                    <TooltipContent>Remove from the queue</TooltipContent>
                  </Tooltip>
                </>}
              </div>
            </li>
          );
        })}
      </ol>
      {collapsible && (
        <Button type="button" size="xs" variant="ghost" className="self-end text-muted-foreground" aria-expanded={showAll} aria-controls={listId}
          // The composer keeps the focus; a key still works it.
          onPointerDown={(event) => event.preventDefault()} onClick={() => setShowAll((all) => !all)}>
          {showAll ? "Show fewer" : `Show all ${items.length} queued`}
          <ChevronDownIcon className={cn("transition-transform duration-150 motion-reduce:transition-none", showAll && "rotate-180")} aria-hidden />
        </Button>
      )}
      {notice && <p role="status" className="self-end pe-1 text-xs text-muted-foreground">{notice}</p>}
    </section>
  );
}
