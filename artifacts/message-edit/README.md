# Message editing (#283)

The web editor reuses the chat composer for existing attachments, uploads, paste and drop. Cancel keeps the original. Save replaces that immutable message revision and later replies, then resends using a fresh engine session. Removing an attachment detaches its reference; the Library file and branched chats survive.

The source message ID is the revision check. The entire rewind, ordered attachment references, outbox entry and scheduled resend commit in one SQLite transaction. Successful uploads and edit requests have retry keys. A stale draft stays open with an error. While a reply is active, the owner can draft an edit and stop the reply from the dialog; saving waits for finalization.

User messages render Markdown while preserving skill links. Attachment popups reuse the Library's image, video, audio, PDF and text preview. Unsupported formats offer a download. Raw HTML and SVG never become executable previews.

Successfully registered uploads follow the existing Library lifecycle, including after cancellation of a failed edit. Editing does not delete those files or introduce a new retention policy.

## Repeat the verification

```sh
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit -p convex
pnpm typecheck
bun scripts/smoke.ts
pnpm build
PERRY_E2E_BROWSER='/path/to/chrome' bun artifacts/message-edit/run.ts /tmp/message-edit-results
```

The E2E run starts the production build, a real runner and SQLite backend, and separate browser profiles in a temporary Perry home. It drives normal uploads and edits, failures and retries, reload, two browser tabs, an active reply and stop, authorization failures, media-only and empty drafts, keyboard controls, mobile layout, Markdown and media previews. It saves `result.json`, `edit-desktop.png` and `edit-mobile.png`, then stops its processes and deletes its temporary home. The recorded result and screenshots beside this file are from the final verification run.

The model is the repository's fake ACP agent. No real model provider, Telegram or WhatsApp account participates. Engine input is checked at the real runner and fake agent boundary; this does not test a model's understanding of the media. The production build has three existing filesystem tracing warnings in `convex/lib/browser.ts`, `convex/pet.ts` and `server/wake.ts`.
