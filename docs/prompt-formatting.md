# Prompt formatting (#307)

The owner writes long instructions in Perry's existing chat composer, including code and lists. The composer should help structure those instructions while preserving the exact Markdown sent to the agent. A familiar text input with a small formatting row and an optional preview fits this job.

Considered a rich-text editor using the installed Tiptap stack, a separate full-screen prompt document, and Markdown with selection controls. Choose Markdown controls: existing refs, command completion, skill mentions, drafts and message editing already depend on a textarea and string offsets. A second editor would introduce serialization and caret conversions. A full-screen editor hides the conversation during a common action.

Keep the textarea as the source of truth. Format selected text, retain native typing/paste/undo behavior, and preview with the existing safe Markdown libraries. Never execute HTML. Formatting is local; sending still uses the existing action.

Failure inventory before E2E checks:

- Selection or focus is lost when clicking a toolbar action.
- Formatting overwrites adjacent text or fails across multiple lines.
- Existing backticks prematurely close inserted inline/code fences.
- Undo/redo loses formatting or ordinary typed text.
- Preview changes the source, triggers a send, executes HTML, or cannot return to editing.
- Enter, Shift+Enter, IME composition or command/skill suggestions regress.
- Editing a message, attachment paste, or a read-only state bypasses existing guards.
- Long text hides controls or overflows on a phone.
- External draft writes are not reflected in the mounted textarea.
- Formatting keyboard shortcuts conflict with browser shortcuts when focus is elsewhere.

Use browser workflow evidence against an isolated instance with fake engines. Record raw submitted text, preview structure, selections, undo/redo and narrow-screen layout. No paid calls or owner account data are needed.

## Delivered behavior

Formatting options reveal selection controls for bold, italic, lists, inline code and code blocks. Ctrl/Cmd+B and Ctrl/Cmd+I operate in the textarea. Lists preserve indentation and blank lines; fenced blocks choose a delimiter longer than any selected backtick run. Preview uses safe Markdown with inert HTML and no remote image loading. Sending from preview returns to editing.

Draft source is kept in sessionStorage per chat/project/new-chat scope and restored after reload in the same tab. Sending clears that draft. This is local draft recovery, not a server-synced or cross-device draft system. Textarea attachment handling, command/skill completion and message editing continue through the existing composer.

## Verification

The production build passed. The browser workflow passed all 24 checks against an isolated Windows production instance with a fake engine, including native undo/redo, real pointer clicks, format toggles, list/code edge cases, safe preview, Shift+Enter, IME Enter, command suggestions, reload recovery, 375px layout, exact submitted source and edit/resend isolation.

```powershell
pnpm build
$env:PERRY_E2E_DIR = 'W:\perry-qa'
pnpm exec bun artifacts/prompt-formatting/run.ts W:/perry-qa/prompt-formatting
```

JSON and desktop/mobile screenshots are under artifacts/prompt-formatting. Chromium on Windows was exercised; the native insertion fallback on other browser engines needs platform verification. Existing build tracing warnings in convex/pet.ts and server/wake.ts remain.
