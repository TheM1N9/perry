"use client";

// Adapted from CopilotKit/OpenDots (MIT): src/client/editor/RichEditor.tsx
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import {
  BoldIcon, CodeIcon, Heading2Icon, ItalicIcon, Link2Icon, ListChecksIcon, ListIcon, ListOrderedIcon, QuoteIcon, Redo2Icon, Undo2Icon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { documentExtensions } from "./markdown";
import { SlashCommands } from "./slash-commands";

/**
 * A note's words in TipTap, read and written as Markdown. "/" at the start of
 * a line offers blocks; Ctrl+click opens a link (a note's opens here, any
 * other in a new tab). The value the editor was last given or gave back is
 * remembered, so a newer note from the server replaces what is shown without
 * the editor echoing it back as an edit.
 */
export function NoteEditor({ value, onChange, onBlur, label }: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  label: string;
}) {
  const router = useRouter();
  const change = useRef(onChange);
  change.current = onChange;
  const blur = useRef(onBlur);
  blur.current = onBlur;
  const emitted = useRef(value);
  const editor = useEditor({
    extensions: [
      ...documentExtensions(),
      Markdown,
      Placeholder.configure({ placeholder: "Write, or type / for blocks…" }),
      SlashCommands,
    ],
    content: value,
    contentType: "markdown",
    immediatelyRender: false,
    editorProps: {
      attributes: { class: "prose-note min-h-[50vh] outline-none", "aria-label": label, role: "textbox", "aria-multiline": "true", "data-note-editor": "" },
      handleClick: (_view, _pos, event) => {
        const href = (event.target instanceof Element ? event.target.closest("a") : null)?.getAttribute("href");
        if (!href || !(event.metaKey || event.ctrlKey)) return false;
        event.preventDefault();
        if (href.startsWith("/")) router.push(href);
        else window.open(href, "_blank", "noopener,noreferrer");
        return true;
      },
    },
    onUpdate: ({ editor: current }) => {
      const markdown = current.getMarkdown();
      emitted.current = markdown;
      change.current(markdown);
    },
    onBlur: () => blur.current?.(),
  });
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => current ? {
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      heading: current.isActive("heading", { level: 2 }),
      bullet: current.isActive("bulletList"),
      ordered: current.isActive("orderedList"),
      task: current.isActive("taskList"),
      quote: current.isActive("blockquote"),
      code: current.isActive("codeBlock"),
      link: current.isActive("link"),
      undo: current.can().undo(),
      redo: current.can().redo(),
    } : null,
  });
  // A newer note from the server (Perry added to it, or the conflict was settled): shown in place.
  useEffect(() => {
    if (editor && value !== emitted.current) {
      emitted.current = value;
      editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
    }
  }, [editor, value]);

  if (!editor) return <div className="min-h-[50vh]" aria-busy="true" />;
  const run = (action: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => () => void action(editor.chain().focus()).run();
  return (
    <div>
      <div role="toolbar" aria-label="Formatting" className="sticky top-12 z-10 -mx-1 mb-4 flex flex-wrap items-center gap-0.5 bg-background/85 py-1 backdrop-blur-md">
        <Tool label="Bold (Ctrl+B)" active={state?.bold} onClick={run((c) => c.toggleBold())}><BoldIcon /></Tool>
        <Tool label="Italic (Ctrl+I)" active={state?.italic} onClick={run((c) => c.toggleItalic())}><ItalicIcon /></Tool>
        <Tool label="Heading" active={state?.heading} onClick={run((c) => c.toggleHeading({ level: 2 }))}><Heading2Icon /></Tool>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <Tool label="Bullet list" active={state?.bullet} onClick={run((c) => c.toggleBulletList())}><ListIcon /></Tool>
        <Tool label="Numbered list" active={state?.ordered} onClick={run((c) => c.toggleOrderedList())}><ListOrderedIcon /></Tool>
        <Tool label="Checklist" active={state?.task} onClick={run((c) => c.toggleTaskList())}><ListChecksIcon /></Tool>
        <Tool label="Quote" active={state?.quote} onClick={run((c) => c.toggleBlockquote())}><QuoteIcon /></Tool>
        <Tool label="Code block" active={state?.code} onClick={run((c) => c.toggleCodeBlock())}><CodeIcon /></Tool>
        <LinkTool editor={editor} active={state?.link} />
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <Tool label="Undo" disabled={!state?.undo} onClick={run((c) => c.undo())}><Undo2Icon /></Tool>
        <Tool label="Redo" disabled={!state?.redo} onClick={run((c) => c.redo())}><Redo2Icon /></Tool>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

function Tool({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}
          className={cn("text-muted-foreground", active && "bg-accent text-foreground")} />
      }>
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** A link on the selection: a web address, or another note's (/notes/…); empty takes it off. */
function LinkTool({ editor, active }: { editor: Editor; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState("");
  const [problem, setProblem] = useState("");
  const apply = () => {
    const url = href.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      setOpen(false);
      return;
    }
    if (!/^(https?:\/\/|mailto:|\/notes\/)/i.test(url)) {
      setProblem("Use a web address (https://…) or a note's link (/notes/…).");
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) { setHref(editor.getAttributes("link").href ?? ""); setProblem(""); }
    }}>
      <PopoverTrigger render={
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Link" aria-pressed={active} className={cn("text-muted-foreground", active && "bg-accent text-foreground")} />
      }>
        <Link2Icon />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <form className="flex gap-1.5" onSubmit={(event) => { event.preventDefault(); apply(); }}>
          <Input autoFocus aria-label="Link address" value={href} placeholder="https://… or /notes/…" onChange={(event) => { setHref(event.target.value); setProblem(""); }} />
          <Button type="submit" size="sm" className="h-8">Set</Button>
        </form>
        {problem && <p className="text-xs text-destructive">{problem}</p>}
      </PopoverContent>
    </Popover>
  );
}
