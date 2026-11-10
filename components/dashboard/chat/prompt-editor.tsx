"use client";

import { Extension } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import { splitBlock } from "@tiptap/pm/commands";
import { liftListItem, splitListItem } from "@tiptap/pm/schema-list";
import { Plugin, Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

/*
 * The composer's words in TipTap, formatted as they are typed, Notion's way: **bold**, _italic_, `code`, ~~strike~~,
 * "- " or "1. " for a list, "> " for a quote, "# " for a heading and "```" for code. Backspace right after takes
 * the formatting back. What is sent is still Markdown (getMarkdown), with plain text exactly as typed (see verbatim).
 */

export type PromptHandle = {
  focus: () => void;
  /** The editable element, for a dialog's first focus; null until the editor is made. */
  readonly element: HTMLElement | null;
  /** The text of the caret's block on either side of it. */
  around: () => { before: string; after: string };
  /** Put `text` in place of `before` characters before the caret and `after` after it, the caret after it. */
  replaceAroundCaret: (before: number, after: number, text: string) => void;
};

type Attributes = Record<string, string | undefined>;
const defined = (attributes: Attributes) => Object.fromEntries(Object.entries(attributes).filter((entry): entry is [string, string] => entry[1] !== undefined));

/**
 * TipTap escapes text for Markdown that is read back (foo\_bar, C:\\Users, &lt;div&gt;). A prompt is read by an
 * agent, which would get the backslashes and entities too, so text goes out as typed, as the textarea sent it.
 * Code needs no exception: its text was never escaped.
 */
function verbatim(editor: Editor) {
  (editor.markdown as unknown as { encodeTextForMarkdown: (text: string) => string }).encodeTextForMarkdown = (text) => text;
}

/** The caret's block, as text: a line break as a newline, anything else that is not text as nothing. */
function around(view: EditorView) {
  const { $from } = view.state.selection;
  const block = $from.parent;
  return {
    before: block.textBetween(0, $from.parentOffset, undefined, (leaf) => leaf.type.name === "hardBreak" ? "\n" : ""),
    after: block.textBetween($from.parentOffset, block.content.size, undefined, (leaf) => leaf.type.name === "hardBreak" ? "\n" : ""),
  };
}

const inside = (view: EditorView, name: string) => {
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type.name === name) return true;
  return false;
};

export function PromptEditor({
  ref, value, onChange, onCaret, onSubmit, onKeyDown, onFiles, placeholder, attributes, aria, disabled, autoFocus, className,
}: {
  ref?: Ref<PromptHandle>;
  /** Markdown. */
  value: string;
  onChange: (value: string) => void;
  /** The caret's block before the caret, as it changes: a $name is completed where it is typed. */
  onCaret?: (before: string) => void;
  onSubmit: () => void;
  /** Keys the composer takes first (its suggestions, Escape); true when it took one. */
  onKeyDown?: (event: KeyboardEvent) => boolean;
  /** Files pasted in; true when they were taken. */
  onFiles?: (files: File[]) => boolean;
  placeholder: string;
  /** Set when the editor is made: its id and role. */
  attributes: Attributes;
  /** What changes as it is used: its name, and the suggestions it controls. */
  aria: Attributes;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  // The editor is made once; what it calls back reads the latest props.
  const latest = useRef({ onChange, onCaret, onSubmit, onKeyDown, onFiles, placeholder, aria });
  latest.current = { onChange, onCaret, onSubmit, onKeyDown, onFiles, placeholder, aria };
  // The Markdown last given or given back, so a draft written from outside replaces what is shown, and only then.
  const emitted = useRef(value);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        underline: false,
        // A link stays the words typed: no [address](address) sent for an address typed or pasted.
        link: { openOnClick: false, autolink: false },
      }),
      Markdown,
      Placeholder.configure({ placeholder: () => latest.current.placeholder }),
      // TipTap takes the editor's own attributes once, so what changes is said through a plugin's.
      Extension.create({ name: "promptAria", addProseMirrorPlugins: () => [new Plugin({ props: { attributes: () => defined(latest.current.aria) } })] }),
    ],
    content: value,
    contentType: "markdown",
    immediatelyRender: false,
    autofocus: autoFocus ? "end" : false,
    editable: !disabled,
    onCreate: ({ editor: made }) => verbatim(made),
    editorProps: {
      attributes: { ...defined(attributes), class: "prose-prompt outline-none", "aria-multiline": "true" },
      handleDOMEvents: {
        // A bare Ctrl/Cmd+B is left to the page, which opens or closes the sidebar; with words chosen it is bold.
        keydown: (view, event) => (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "b" && view.state.selection.empty,
      },
      handleKeyDown: (view, event) => {
        if (event.isComposing || view.composing) return false;
        if (latest.current.onKeyDown?.(event)) return true;
        if (event.key !== "Enter") return false;
        if (event.ctrlKey || event.metaKey) { latest.current.onSubmit(); return true; }
        const code = inside(view, "codeBlock");
        const list = inside(view, "listItem");
        if (event.shiftKey) {
          // A new line: in code, a list's next item, or the next paragraph.
          const { state, dispatch } = view;
          if (code) dispatch(state.tr.insertText("\n").scrollIntoView());
          else if (list) splitListItem(state.schema.nodes.listItem)(state, dispatch) || liftListItem(state.schema.nodes.listItem)(state, dispatch);
          else splitBlock(state, dispatch);
          return true;
        }
        // In code or a list Enter goes on writing it (a list's empty item ends it, as do two empty lines in code).
        if (code || list) return false;
        // "```" or "```ts" on a line of its own starts code, as "```" and a space does.
        const fence = view.state.selection.$from.parent.textContent.match(/^```([\w+#-]*)$/);
        if (fence && view.state.selection.empty) {
          const { $from } = view.state.selection;
          const tr = view.state.tr.delete($from.start(), $from.end());
          tr.setBlockType($from.start(), $from.start(), view.state.schema.nodes.codeBlock, { language: fence[1] || null });
          view.dispatch(tr.scrollIntoView());
          return true;
        }
        latest.current.onSubmit();
        return true;
      },
      handlePaste: (view, event) => {
        const data = event.clipboardData;
        if (!data) return false;
        const files = Array.from(data.files);
        if (files.length) { event.preventDefault(); return latest.current.onFiles?.(files) ?? true; }
        const text = data.getData("text/plain").replace(/\r\n?/g, "\n");
        if (!text || inside(view, "codeBlock")) return false;
        // Lines copied from VS Code are code; anything else with HTML (a web page, a document) keeps its formatting.
        const vscode = data.types.includes("vscode-editor-data");
        if (vscode && text.includes("\n")) {
          let language: string | null = null;
          try { language = (JSON.parse(data.getData("vscode-editor-data")) as { mode?: string }).mode ?? null; } catch {}
          const node = view.state.schema.nodes.codeBlock.create({ language: language === "plaintext" ? null : language }, view.state.schema.text(text));
          view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
          return true;
        }
        if (!vscode && data.types.includes("text/html")) return false;
        // Plain text stays as it was copied, line by line: a log, a stack trace, Markdown.
        view.dispatch(view.state.tr.insertText(text).scrollIntoView());
        return true;
      },
    },
    onUpdate: ({ editor: changed }) => {
      // A list, a quote or code ends with a blank line of TipTap's; the draft ends where the words do.
      const markdown = changed.isEmpty ? "" : changed.getMarkdown().replace(/\n+$/, "");
      emitted.current = markdown;
      latest.current.onChange(markdown);
    },
    onTransaction: ({ editor: changed }) => latest.current.onCaret?.(around(changed.view).before),
  });

  // A draft written from outside (a command picked, a starter, a queued message to edit, a sent one cleared).
  useEffect(() => {
    if (!editor || value === emitted.current) return;
    emitted.current = value;
    editor.chain()
      .command(({ tr }) => { tr.setMeta("addToHistory", false); return true; })
      .setContent(value, { contentType: "markdown", emitUpdate: false })
      .command(({ tr }) => { tr.setSelection(Selection.atEnd(tr.doc)); return true; })
      .run();
  }, [editor, value]);

  useEffect(() => { editor?.setEditable(!disabled, false); }, [editor, disabled]);

  // The placeholder and the combobox's state are props of the view: shown again when they change.
  const ariaKey = JSON.stringify(aria);
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.updateState(editor.view.state);
  }, [editor, placeholder, ariaKey]);

  useImperativeHandle(ref, () => ({
    focus: () => { editor?.commands.focus(); },
    get element() { return editor && !editor.isDestroyed ? editor.view.dom : null; },
    around: () => editor ? around(editor.view) : { before: "", after: "" },
    replaceAroundCaret: (before, after, text) => {
      editor?.chain().focus().command(({ tr }) => {
        const at = tr.selection.from;
        tr.insertText(text, at - before, at + after);
        tr.setSelection(TextSelection.create(tr.doc, at - before + text.length));
        return true;
      }).run();
    },
  }), [editor]);

  return editor
    ? <EditorContent editor={editor} className={className} />
    // Until the editor is made (it is made in the browser): the same box, with its placeholder.
    : <div className={className} aria-busy="true"><p className="prose-prompt text-muted-foreground">{placeholder}</p></div>;
}
