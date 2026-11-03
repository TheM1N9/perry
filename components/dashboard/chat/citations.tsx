"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { PencilIcon, QuoteIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";

export type Citation = { id: string; text: string; comment: string };

export function citedMessage(citations: Citation[], draft: string) {
  return [...citations.map(({ text, comment }) => [text.split(/\r?\n/).map((line) => `> ${line}`).join("\n"), comment.trim()].filter(Boolean).join("\n\n")), draft.trim()].filter(Boolean).join("\n\n");
}

/** One selection listener for the conversation, including commentary and the live reply. */
export function SelectionCite({ container, onCite }: { container: RefObject<HTMLElement | null>; onCite: (text: string) => void }) {
  const [selected, setSelected] = useState<{ text: string; rect: DOMRect } | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const read = () => {
      if (popup.current?.contains(document.activeElement)) return;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) { setSelected(null); return; }
      const range = selection.getRangeAt(0);
      const element = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE ? range.commonAncestorContainer as Element : range.commonAncestorContainer.parentElement;
      const source = element?.closest("[data-cite-text]");
      const text = selection.toString();
      if (!text.trim() || !source || !container.current?.contains(source)) { setSelected(null); return; }
      const rect = range.getBoundingClientRect();
      if (rect.width || rect.height) setSelected({ text, rect });
    };
    const clear = () => setSelected(null);
    let frame = 0;
    const onPointerUp = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(read);
    };
    document.addEventListener("selectionchange", read);
    document.addEventListener("pointerup", onPointerUp);
    // Dismiss on scroll rather than leave a button floating over unrelated text.
    const scroller = container.current;
    scroller?.addEventListener("scroll", clear, { passive: true });
    window.addEventListener("resize", clear);
    return () => {
      document.removeEventListener("selectionchange", read);
      document.removeEventListener("pointerup", onPointerUp);
      cancelAnimationFrame(frame);
      scroller?.removeEventListener("scroll", clear);
      window.removeEventListener("resize", clear);
    };
  }, [container]);

  return selected && <PopoverPrimitive.Root open onOpenChange={(open) => { if (!open) setSelected(null); }}>
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner anchor={{ getBoundingClientRect: () => selected.rect }} side="bottom" sideOffset={6} collisionPadding={8} positionMethod="fixed" className="z-50">
        <PopoverPrimitive.Popup ref={popup} initialFocus={false} finalFocus={false} aria-label="Cite selected text" className="rounded-full bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10">
          <Button type="button" variant="ghost" size="sm" className="rounded-full" onMouseDown={(event) => event.preventDefault()} onClick={() => {
            onCite(selected.text);
            setSelected(null);
            window.getSelection()?.removeAllRanges();
          }}><QuoteIcon aria-hidden />Cite</Button>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>;
}

export function CitationChips({ citations, onChange }: { citations: Citation[]; onChange: (citations: Citation[]) => void }) {
  return <ul aria-label="Citations" className="flex max-h-40 flex-col gap-1 overflow-y-auto px-4 pt-3">
    {citations.map((citation) => <CitationChip key={citation.id} citation={citation}
      onSave={(comment) => onChange(citations.map((item) => item.id === citation.id ? { ...item, comment } : item))}
      onRemove={() => onChange(citations.filter((item) => item.id !== citation.id))} />)}
  </ul>;
}

function CitationChip({ citation, onSave, onRemove }: { citation: Citation; onSave: (comment: string) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState(citation.comment);
  return <li className="flex min-w-0 items-center gap-1 text-primary">
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) setComment(citation.comment); }}>
      <PopoverTrigger render={<Button type="button" variant="ghost" size="sm" className="min-w-0 justify-start font-normal text-primary" aria-label={`Edit citation: ${citation.text}`} />}>
        <QuoteIcon className="shrink-0" aria-hidden /><span className="truncate">{citation.comment || citation.text}</span><PencilIcon className="size-3 shrink-0" aria-hidden />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" collisionPadding={12} className="w-80 max-w-[calc(100vw-1.5rem)] p-3" aria-label="Edit citation">
        <form onSubmit={(event) => { event.preventDefault(); onSave(comment); setOpen(false); }} className="flex flex-col gap-3">
          <blockquote className="max-h-32 overflow-y-auto border-l-2 pl-3 text-sm whitespace-pre-wrap text-muted-foreground">{citation.text}</blockquote>
          <label className="flex flex-col gap-1.5 text-sm">Comment <span className="sr-only">(optional)</span>
            <Textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Add an optional comment…" className="min-h-24 focus-visible:ring-2 focus-visible:ring-ring/50"
              onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" size="sm">Save</Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
    <Button type="button" variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={`Remove citation: ${citation.text}`} onClick={onRemove}><XIcon aria-hidden /></Button>
  </li>;
}
