"use client";

import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
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
 * email, and links open in a new tab.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
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
          table: ({ node: _node, ...props }) => <div className="overflow-x-auto rounded-lg border"><table {...props} /></div>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
