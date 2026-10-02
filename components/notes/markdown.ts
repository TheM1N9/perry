// Adapted from CopilotKit/OpenDots (MIT): src/client/editor/markdown.ts
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";

/**
 * What a note can hold in the editor: GitHub-flavoured Markdown's everyday
 * blocks (headings, lists, checklists, quotes, code, tables, links). A note
 * with anything else (an image, HTML, footnotes, front matter) opens as its
 * Markdown instead, so nothing in it is lost on the way through the editor.
 */
export const documentExtensions = () => [
  StarterKit.configure({
    underline: false,
    link: { openOnClick: false, autolink: false },
    heading: { levels: [1, 2, 3] },
  }),
  TableKit.configure({ table: { resizable: false } }),
  TaskList,
  TaskItem.configure({ nested: true }),
];

let manager: MarkdownManager | null = null;
const markdownManager = () => (manager ??= new MarkdownManager({ extensions: documentExtensions() }));

const ALLOWED = new Set([
  "space", "code", "heading", "table", "hr", "blockquote", "list", "list_item", "paragraph", "text", "escape",
  "strong", "em", "codespan", "br", "del", "link", "taskList", "taskItem",
]);

/** Whether the editor can show this Markdown and give it back unchanged in meaning; why not, when not. */
export function inspectMarkdown(source: string): { supported: boolean; reason?: string } {
  try {
    if (/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(source) || /^\[\^[^\]]+\]:/m.test(source) || /^\s*(\$\$|:::)/m.test(source)) {
      return { supported: false, reason: "It has Markdown the editor doesn't show." };
    }
    const tokens = markdownManager().instance.lexer(source);
    let unsupported = false;
    const pending: unknown[] = [tokens];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== "object") continue;
      if ("type" in value && typeof value.type === "string"
        && (!ALLOWED.has(value.type) || (value.type === "heading" && "depth" in value && typeof value.depth === "number" && value.depth > 3))) {
        unsupported = true;
      }
      pending.push(...Object.values(value));
    }
    if (unsupported) return { supported: false, reason: "It has images, HTML or small headings the editor doesn't show." };
    const parsed = markdownManager().parse(source);
    const restored = markdownManager().parse(markdownManager().serialize(parsed));
    if (JSON.stringify(parsed) !== JSON.stringify(restored)) return { supported: false, reason: "Some of its formatting wouldn't survive the editor." };
    return { supported: true };
  } catch {
    return { supported: false, reason: "The editor can't read it." };
  }
}
