"use client";

import { FileIcon, FileTextIcon, PuzzleIcon } from "lucide-react";
import Link from "next/link";
import { createContext, memo, useContext, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { SKILL_MENTION } from "@/convex/lib/commands";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Checkbox } from "@/components/ui/checkbox";
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

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
 * A reply's link to a file on this computer: opened from the media server when
 * it is one of the chat's files, else the path, shown and not followed (a path
 * is no page of Perry's, so following it would only open Perry again).
 */
function FileLink({ path, children }: { path: string; children: ReactNode }) {
  const file = chatFile(useContext(ChatFiles), path);
  if (file) return <a href={file.url} target="_blank" rel="noopener noreferrer" title={file.path} data-file-link className="inline-flex items-baseline gap-1">
    <FileIcon className="size-3.5 self-center" aria-hidden />{children}
  </a>;
  return <span title={`${path} (not a file Perry can open from here)`} data-file-path className="inline-flex items-baseline gap-1 font-medium">
    <FileIcon className="size-3.5 self-center text-muted-foreground" aria-hidden />{children}
  </span>;
}

/** A fenced block: its language and a copy button above, the code highlighted when Perry knows the language. */
function Code({ children }: { children: ReactNode }) {
  const language = languageOf(children);
  const code = textOf(children).replace(/\n$/, "");
  const lines = useHighlightedCode(code, language ?? "text");
  return (
    <CodeBlock className="bg-muted/50">
      <CodeBlockHeader>
        <CodeBlockTitle className="font-mono text-xs font-normal text-muted-foreground">{language ?? "text"}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={code} aria-label="Copy code" />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent>
        {lines.map((line, index) => <CodeBlockLine key={index}>{line}</CodeBlockLine>)}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/**
 * The files a chat can open, by where they are on this computer
 * (dashboard.getChatFiles): a reply's link to one opens it, and a link to any
 * other path is only shown, since nothing would serve it.
 */
export const ChatFiles = createContext<ReadonlyArray<{ path: string; url: string }>>([]);

/** Perry's own pages (app/(app), and next.config.ts's short ways to them): a link to one stays in the app. */
const PAGES = new Set(["chat", "todos", "projects", "library", "settings", "work", "brain", "notes", "apps", "inbox", "welcome", "pet",
  "keys", "setup", "connectors", "skills", "computer", "activity", "api"]);

/**
 * Where a link to a file on this computer points, or null for a web address
 * or one of Perry's pages. A reply names a file as an absolute path, a
 * file:// address, ~/ or a path relative to where it worked, sometimes with
 * the line after it ("app.ts:12", "app.ts#L12").
 */
function filePath(href: string): string | null {
  if (/^file:/i.test(href)) href = href.replace(/^file:\/\/(?:localhost)?/i, "").replace(/^\/([a-zA-Z]:)/, "$1");
  // A scheme has two letters or more; one letter and a colon is a Windows drive.
  else if (/^[a-zA-Z][\w+.-]+:/.test(href) || href.startsWith("#") || href.startsWith("//")) return null;
  else if (href.startsWith("/") && PAGES.has(href.slice(1).split(/[/?#]/)[0]!)) return null;
  try { href = decodeURI(href); } catch {}
  return href.replace(/#L?\d+(?:-L?\d+)?$/, "").replace(/:\d+(?::\d+)?$/, "") || null;
}

const slashes = (path: string) => path.replace(/\\/g, "/");

/** The file of the chat's at that path: the same path, or for a relative one, the newest whose path ends with it. */
function chatFile(files: ReadonlyArray<{ path: string; url: string }>, path: string) {
  const want = slashes(path);
  const exact = files.find((file) => slashes(file.path) === want);
  if (exact || /^(?:[a-zA-Z]:)?\//.test(want)) return exact;
  const tail = `/${want.replace(/^(?:~|\.)?\//, "").replace(/^(?:\.\.\/)+/, "")}`;
  return files.find((file) => slashes(file.path).endsWith(tail));
}

/** Keeps a file:// link, which react-markdown would empty (and an empty link opens Perry again); filePath reads it. */
const urlTransform = (url: string) => /^file:/i.test(url) ? url : defaultUrlTransform(url);

type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] };

/** Preserve skill links in user Markdown, without rewriting code or existing links. */
function skillLinks({ skills }: { skills?: ReadonlySet<string> }) {
  return (tree: MarkdownNode) => {
    function visit(node: MarkdownNode) {
      if (!node.children || ["link", "linkReference", "code", "inlineCode", "image", "html"].includes(node.type)) return;
      node.children = node.children.flatMap((child): MarkdownNode[] => {
        if (child.type !== "text" || !child.value || !skills?.size) { visit(child); return [child]; }
        const parts: MarkdownNode[] = [];
        let from = 0;
        for (const match of child.value.matchAll(SKILL_MENTION)) {
          if (!skills.has(match[1])) continue;
          parts.push({ type: "text", value: child.value.slice(from, match.index) });
          parts.push({ type: "link", url: `/apps/skills?skill=${encodeURIComponent(match[1])}`, children: [{ type: "text", value: match[0] }] });
          from = match.index + match[0].length;
        }
        parts.push({ type: "text", value: child.value.slice(from) });
        return parts;
      });
    }
    visit(tree);
  };
}

/**
 * Messages are GitHub-flavoured Markdown, with single line breaks kept as a
 * chat reader expects. Raw HTML stays text, since replies quote web pages and
 * email, and links open in a new tab, except a link to one of the owner's
 * pages (/brain/…, or /notes/… from before Brain), which opens it here. A checklist's boxes and a table are
 * Perry's own, read-only: ticking one would not tell Perry anything.
 */
export const Markdown = memo(function Markdown({ text, openNote, skills }: {
  text: string;
  skills?: ReadonlySet<string>;
  /** Where a note's link goes instead, in a window that is not the dashboard's (the pet's). */
  openNote?: (href: string) => void;
}) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, [skillLinks, { skills }]]}
        urlTransform={urlTransform}
        components={{
          a: ({ node: _node, href, children, ...props }) => {
            const skill = href?.startsWith("/apps/skills?") ? new URLSearchParams(href.split("?")[1]).get("skill") : null;
            if (href && skill && skills?.has(skill)) return <Tooltip>
              <TooltipTrigger render={<Link href={href} data-skill-mention={skill} aria-label={`$${skill}: the ${skill} skill`} />}
                className="rounded-md bg-primary/10 px-1.5 py-0.5 font-medium text-primary no-underline outline-none [box-decoration-break:clone] hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring/50">
                <PuzzleIcon className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />{children}
              </TooltipTrigger>
              <TooltipContent>The {skill} skill</TooltipContent>
            </Tooltip>;
            if (href?.startsWith("/brain/") || href?.startsWith("/notes/")) return <Link href={href} data-note-link className="inline-flex items-baseline gap-1" onClick={openNote ? (event) => { event.preventDefault(); openNote(href); } : undefined}>
              <FileTextIcon className="size-3.5 self-center" aria-hidden />{children}
            </Link>;
            // Emptied by urlTransform (javascript: and the like): an empty link would open Perry again.
            if (!href) return <span>{children}</span>;
            const path = filePath(href);
            if (path !== null) return <FileLink path={path}>{children}</FileLink>;
            if (href.startsWith("/")) return <Link href={href}>{children}</Link>;
            return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
          },
          pre: ({ node: _node, children }) => <Code>{children}</Code>,
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
