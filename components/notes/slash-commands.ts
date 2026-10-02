// Adapted from CopilotKit/OpenDots (MIT): src/client/editor/slash-commands.ts
import { Extension, type Editor, type Range } from "@tiptap/core";
import Suggestion, { exitSuggestion, type SuggestionProps } from "@tiptap/suggestion";

/**
 * "/" at the start of a line in a note: a short menu of blocks to put there,
 * filtered as you type, picked with the arrows and Enter or a click.
 */

type Block = { title: string; hint: string; run: (editor: Editor, range: Range) => void };

const command = (action: (editor: Editor) => void) => (editor: Editor, range: Range) => {
  editor.chain().focus().deleteRange(range).run();
  action(editor);
};

export const BLOCKS: Block[] = [
  { title: "Text", hint: "Plain paragraph", run: command((e) => e.chain().setParagraph().run()) },
  ...([1, 2, 3] as const).map((level) => ({
    title: `Heading ${level}`,
    hint: level === 1 ? "Big heading" : level === 2 ? "Section heading" : "Small heading",
    run: command((e) => e.chain().setHeading({ level }).run()),
  })),
  { title: "Bullet list", hint: "Simple list", run: command((e) => e.chain().toggleBulletList().run()) },
  { title: "Numbered list", hint: "Steps in order", run: command((e) => e.chain().toggleOrderedList().run()) },
  { title: "Checklist", hint: "Things to tick off", run: command((e) => e.chain().toggleTaskList().run()) },
  { title: "Quote", hint: "Set a passage apart", run: command((e) => e.chain().toggleBlockquote().run()) },
  { title: "Code", hint: "Code block", run: command((e) => e.chain().toggleCodeBlock().run()) },
  { title: "Divider", hint: "Line between parts", run: command((e) => e.chain().setHorizontalRule().run()) },
  { title: "Table", hint: "Three columns", run: command((e) => e.chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()) },
];

const MENU = "fixed z-50 max-h-80 w-64 overflow-y-auto rounded-xl border bg-popover p-1 text-popover-foreground shadow-raised";
const ITEM = "flex w-full flex-col items-start rounded-lg px-2.5 py-1.5 text-left outline-none";

export const SlashCommands = Extension.create({
  name: "slashCommands",
  addProseMirrorPlugins() {
    return [
      Suggestion<Block>({
        editor: this.editor,
        char: "/",
        startOfLine: true,
        allowedPrefixes: null,
        items: ({ query }) => BLOCKS.filter((block) => `${block.title} ${block.hint}`.toLowerCase().includes(query.toLowerCase())),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: () => {
          let menu: HTMLDivElement | undefined;
          let current: SuggestionProps<Block> | undefined;
          let index = 0;
          const close = () => {
            menu?.remove();
            menu = undefined;
            const dom = current?.editor.view.dom;
            dom?.removeAttribute("aria-controls");
            dom?.removeAttribute("aria-activedescendant");
            dom?.removeAttribute("aria-autocomplete");
            document.removeEventListener("pointerdown", outside);
          };
          const outside = (event: PointerEvent) => {
            if (menu && !menu.contains(event.target as Node)) {
              if (current) exitSuggestion(current.editor.view);
              close();
            }
          };
          const paint = () => {
            if (!menu || !current) return;
            const props = current;
            menu.replaceChildren();
            if (!props.items.length) {
              const empty = document.createElement("p");
              empty.className = "px-2.5 py-1.5 text-sm text-muted-foreground";
              empty.textContent = "No such block";
              menu.append(empty);
            }
            props.items.forEach((item, i) => {
              const button = document.createElement("button");
              button.type = "button";
              button.id = `note-block-${i}`;
              button.setAttribute("role", "option");
              button.setAttribute("aria-selected", String(i === index));
              button.className = `${ITEM} ${i === index ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"}`;
              const title = document.createElement("span");
              title.className = "text-sm font-medium";
              title.textContent = item.title;
              const hint = document.createElement("span");
              hint.className = "text-xs text-muted-foreground";
              hint.textContent = item.hint;
              button.append(title, hint);
              button.addEventListener("mousedown", (event) => event.preventDefault());
              button.addEventListener("click", () => props.command(item));
              menu!.append(button);
            });
            const rect = props.clientRect?.();
            if (rect) {
              menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - 268))}px`;
              menu.style.top = `${Math.max(12, Math.min(rect.bottom + 6, window.innerHeight - 330))}px`;
            }
            props.editor.view.dom.setAttribute("aria-activedescendant", `note-block-${index}`);
            menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
          };
          return {
            onStart: (props) => {
              current = props;
              index = 0;
              menu = document.createElement("div");
              menu.id = "note-block-menu";
              menu.className = MENU;
              menu.setAttribute("role", "listbox");
              menu.setAttribute("aria-label", "Insert block");
              document.body.append(menu);
              props.editor.view.dom.setAttribute("aria-controls", menu.id);
              props.editor.view.dom.setAttribute("aria-autocomplete", "list");
              document.addEventListener("pointerdown", outside);
              paint();
            },
            onUpdate: (props) => {
              current = props;
              index = 0;
              paint();
            },
            onExit: close,
            onKeyDown: ({ event, view }) => {
              if (event.isComposing || view.composing || event.keyCode === 229) return false;
              if (event.key === "Escape") {
                exitSuggestion(view);
                close();
                return true;
              }
              if (!current?.items.length) return false;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                index = (index + (event.key === "ArrowDown" ? 1 : -1) + current.items.length) % current.items.length;
                paint();
                return true;
              }
              if (event.key === "Enter") {
                current.command(current.items[index]);
                return true;
              }
              return false;
            },
          };
        },
      }),
    ];
  },
});
