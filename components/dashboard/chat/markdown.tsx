"use client";

import { FileTextIcon } from "lucide-react";
import Link from "next/link";
import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CopyButton } from "../common";

/** The text of a React node tree, for copying a code block. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

/** The language a fenced block names, from the class react-markdown gives its code. */
function languageOf(node: ReactNode): string | undefined {
  const child = Array.isArray(node) ? node[0] : node;
  const className = child && typeof child === "object" && "props" in child ? (child.props as { className?: string }).className : undefined;
  return className?.match(/language-([\w+-]+)/)?.[1];
}

/**
 * Replies are GitHub-flavoured Markdown, with single line breaks kept as a
 * chat reader expects. Raw HTML stays text, since replies quote web pages and
 * email, and links open in a new tab, except a link to one of the owner's
 * pages (/brain/…, or /notes/… from before Brain), which opens it here. A checklist's boxes and a table are
 * Perry's own, read-only: ticking one would not tell Perry anything.
 */
export const Markdown = memo(function Markdown({ text, openNote }: {
  text: string;
  /** Where a note's link goes instead, in a window that is not the dashboard's (the pet's). */
  openNote?: (href: string) => void;
}) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ node: _node, href, children, ...props }) => href?.startsWith("/brain/") || href?.startsWith("/notes/")
            ? <Link href={href} data-note-link className="inline-flex items-baseline gap-1" onClick={openNote ? (event) => { event.preventDefault(); openNote(href); } : undefined}>
              <FileTextIcon className="size-3.5 self-center" aria-hidden />{children}
            </Link>
            : <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
          pre: ({ node: _node, children, ...props }) => {
            const language = languageOf(children);
            return (
              <div className="group/code overflow-hidden rounded-xl border bg-muted/50">
                <div className="flex h-9 items-center justify-between border-b pr-1.5 pl-4 text-xs text-muted-foreground">
                  <span className="font-mono">{language ?? "text"}</span>
                  <CopyButton value={textOf(children).replace(/\n$/, "")} label="Copy code" size="icon-xs" />
                </div>
                <pre {...props}>{children}</pre>
              </div>
            );
          },
          table: ({ node: _node, ...props }) => <div className="overflow-hidden rounded-lg border"><Table {...props} /></div>,
          thead: ({ node: _node, ...props }) => <TableHeader className="bg-muted/50" {...props} />,
          tbody: ({ node: _node, ...props }) => <TableBody {...props} />,
          tr: ({ node: _node, ...props }) => <TableRow className="hover:bg-transparent" {...props} />,
          th: ({ node: _node, style, ...props }) => <TableHead className="h-9 px-3 font-semibold [overflow-wrap:normal]" style={style} {...props} />,
          td: ({ node: _node, style, ...props }) => <TableCell className="px-3 py-2 align-top whitespace-normal [overflow-wrap:normal]" style={style} {...props} />,
          input: ({ node: _node, type, checked, ...props }) => type === "checkbox"
            ? <Checkbox checked={Boolean(checked)} readOnly tabIndex={-1} className="mr-2 inline-flex align-[-2px]" />
            : <input type={type} checked={checked} {...props} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
