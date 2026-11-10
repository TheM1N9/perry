# Prompt formatting (#307)

The owner writes long instructions in Perry's chat composer, including code and lists. The composer should help structure those instructions while sending the agent Markdown it can read as written.

The first version (a textarea, a "Formatting options" row and a Markdown preview) kept the textarea as the source of truth, because command completion, skill mentions, drafts and message editing depended on string offsets. In use, the row was one more thing to open, and the preview was a second view of the same words. The composer now formats as you type, the way Notion does, and both are gone.

## Behavior

The composer is a TipTap editor (components/dashboard/chat/prompt-editor.tsx). It uses the same StarterKit and Markdown extension as notes.

- **Inline:** `**bold**`, `_italic_`, `` `code` `` and `~~strike~~` format as typed, and their markers disappear. Backspace straight after takes the formatting back.
- **Blocks:** `- `, `1. `, `> ` and `#`/`##`/`###` at a line's start make a list, a quote or a heading. "```" and a space starts code, as does "```lang" and Enter.
- **Enter:** sends the message. In a list it adds the next item, and an empty item ends the list. In code it adds a line, and two empty lines leave the code.
  - **Shift+Enter:** adds a new paragraph or list item.
  - **Ctrl/Cmd+Enter:** sends from anywhere.
- **Keyboard shortcuts:** Ctrl/Cmd+B bolds selected words. With no selection it is left to the page, which opens or closes the sidebar. Ctrl/Cmd+I italicizes.
- **Paste:**
  - Plain text goes in as it was copied, with its line breaks and indentation.
  - Several lines copied from VS Code become code in its language.
  - Anything else with HTML, such as a web page or a document, keeps its formatting.
  - Files are attached.

What is sent is the editor's Markdown. TipTap escapes plain text for Markdown that will be parsed again (`foo\_bar`, `C:\\Users`, `&lt;div&gt;`). An agent would read those backslashes and entities too, so the composer turns that escaping off. Plain text goes out as typed, as the textarea sent it.

The draft is still a Markdown string in sessionStorage, kept per chat, project or new chat. A draft written from outside replaces what is shown, and only then. This covers a command picked, a starter, a queued message to edit, a reload, and a sent message cleared. The composer reports the caret's line up to the caret, so `$name` mentions are found where they are typed and replaced in place. `/` commands are unchanged. The editable element keeps the combobox role, `aria-activedescendant` and the `composer`/`edit-composer` ids.

## Verification

`artifacts/notion-composer/run.ts` uses an isolated production instance with a fake engine, so no paid calls are made. It lists every way the composer could fail and checks each one:

- formatting as typed;
- the exact Markdown sent;
- unescaped plain text;
- Enter, Shift+Enter, Ctrl+Enter and IME Enter;
- lists and code;
- paste;
- command and skill suggestions;
- Ctrl+B;
- reload;
- the message editor;
- a 375px phone.

```powershell
pnpm build
pnpm exec bun artifacts/notion-composer/run.ts artifacts/notion-composer
```

Results and screenshots are written to `artifacts/notion-composer`. Only Chromium on Windows has been exercised.
