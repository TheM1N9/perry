"use client";

import { BoldIcon, CodeIcon, FileCodeIcon, ItalicIcon, ListIcon, ListOrderedIcon } from "lucide-react";
import { type RefObject } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";

export type PromptFormat = "bold" | "italic" | "code" | "block" | "bullet" | "number";

/** Textarea editing keeps command completion and draft offsets in plain Markdown. */
export function formatPrompt(input: HTMLTextAreaElement, format: PromptFormat, changed: (value: string) => void, caret?: (position: number) => void) {
  if (input.disabled) return;
  let start = input.selectionStart;
  let end = input.selectionEnd;
  const source = input.value;
  let selected = source.slice(start, end);
  let replacement: string;
  let selectionStart = 0;
  let selectionEnd = 0;
  if (format === "bullet" || format === "number") {
    start = start === 0 ? 0 : source.lastIndexOf("\n", start - 1) + 1;
    // A selection ending at the next line's start excludes that empty boundary.
    const boundary = end > start && source[end - 1] === "\n" ? end - 1 : end;
    const next = source.indexOf("\n", boundary);
    end = next < 0 ? source.length : next;
    selected = source.slice(start, end);
    const lines = (selected || "List item").split("\n");
    const prefix = format === "bullet" ? /^(\s*)[-+*] / : /^(\s*)\d+\. /;
    const remove = lines.every((line) => !line.trim() || prefix.test(line));
    replacement = lines.map((line, index) => {
      if (!line.trim()) return line;
      if (remove) return line.replace(prefix, "$1");
      const [, indent, text] = line.match(/^(\s*)(.*)$/)!;
      return `${indent}${format === "bullet" ? "-" : `${index + 1}.`} ${text}`;
    }).join("\n");
    selectionEnd = replacement.length;
  } else {
    const text = selected || (format === "block" || format === "code" ? "code" : "text");
    const longestTicks = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
    let before = format === "bold" ? "**" : format === "italic" ? "_" : "`".repeat(longestTicks + 1);
    let after = before;
    if (format === "block") {
      const fence = "`".repeat(Math.max(3, longestTicks + 1));
      before = `${start > 0 && source[start - 1] !== "\n" ? "\n" : ""}${fence}\n`;
      after = `\n${fence}${end < source.length && source[end] !== "\n" ? "\n" : ""}`;
    } else if (format === "code" && /^`|`$/.test(text)) {
      before += " "; after = ` ${after}`;
    }
    if (format !== "block" && selected && source.slice(Math.max(0, start - before.length), start) === before && source.slice(end, end + after.length) === after) {
      start -= before.length;
      end += after.length;
      replacement = text;
      selectionEnd = text.length;
    } else {
      replacement = before + text + after;
      selectionStart = before.length;
      selectionEnd = before.length + text.length;
    }
  }
  input.focus();
  input.setSelectionRange(start, end);
  // Chromium's native insertion preserves the textarea's undo transaction.
  // Other engines retain a working insertion through setRangeText.
  const inserted = document.execCommand("insertText", false, replacement);
  if (!inserted) input.setRangeText(replacement, start, end, "end");
  changed(input.value);
  input.setSelectionRange(start + selectionStart, start + selectionEnd);
  caret?.(start + selectionEnd);
}

const actions = [
  { format: "bold", label: "Bold", Icon: BoldIcon, hint: "Ctrl/Cmd+B" },
  { format: "italic", label: "Italic", Icon: ItalicIcon, hint: "Ctrl/Cmd+I" },
  { format: "bullet", label: "Bullet list", Icon: ListIcon },
  { format: "number", label: "Numbered list", Icon: ListOrderedIcon },
  { format: "code", label: "Inline code", Icon: CodeIcon },
  { format: "block", label: "Code block", Icon: FileCodeIcon },
] as const;

export function PromptFormatting({ input, onChange, onCaret, preview, onPreview, disabled }: {
  input: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onCaret?: (position: number) => void;
  preview: boolean;
  onPreview: (value: boolean) => void;
  disabled: boolean;
}) {
  return <div role="group" aria-label="Prompt formatting" className="flex flex-wrap items-center gap-0.5 border-t px-3 py-1.5">
    {actions.map(({ format, label, Icon, ...extra }) => <Button key={format} type="button" variant="ghost" size="icon-sm"
      aria-label={label} title={`${label}${"hint" in extra ? ` (${extra.hint})` : ""}`} disabled={disabled || preview}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => { if (input.current) formatPrompt(input.current, format, onChange, onCaret); }}>
      <Icon className="size-4" />
    </Button>)}
    <Button type="button" variant="ghost" size="sm" className="ml-auto" disabled={disabled} aria-pressed={preview}
      onClick={() => { onPreview(!preview); if (preview) requestAnimationFrame(() => input.current?.focus()); }}>
      {preview ? "Edit Markdown" : "Preview"}
    </Button>
    <span className="w-full px-1 text-xs text-muted-foreground">Markdown · Shift+Enter for a new line</span>
  </div>;
}

/** No raw HTML plugin: pasted markup stays inert and unsafe link schemes are filtered. */
export function PromptPreview({ text }: { text: string }) {
  return <div role="region" aria-label="Prompt preview" className="max-h-[40vh] min-h-[52px] overflow-auto px-5 py-4 text-base break-words [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_code]:font-mono [&_code]:text-sm [&_a]:underline">
    {text ? <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} skipHtml components={{
      img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
      a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    }}>{text}</ReactMarkdown> : <p className="text-muted-foreground">Nothing to preview yet.</p>}
  </div>;
}
