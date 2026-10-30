# Web chat reaction verification

After `pnpm build`, run:

```powershell
pnpm exec bun artifacts/reactions/web.ts artifacts/reactions/web-results
```

This starts the production app in an isolated home and disposable headless
browser. The script acts as a fixture runner using the real claim/finish and
MCP protocols; no AI engine or installed Perry runs. It writes a report and
desktop/mobile screenshots, then stops its processes and removes its home.

Failure cases recorded before writing the journey:

- Reaction choices are hover-only or inaccessible from keyboard/touch.
- Presets are the only choices, or multi-emoji/text values are accepted as one.
- A reaction is not saved, cannot be changed/removed, or vanishes on reload.
- The agent receives feedback without its target message or treats it as approval.
- A progress reaction is invisible until work finishes or is lost when the
  pending message becomes saved history.
- A reaction-only answer leaves a spinner, sends NO_REPLY, or creates an empty-reply error.
- A reaction can target another chat, a guest conversation, or bypass authentication.
- Reacting creates text spam, copies the whole source chat, or loses earlier history.
- Popovers trap focus, fail to close on Escape, overflow a narrow screen, or
  use controls smaller than 44 pixels on touch devices.
- Errors close the picker and pretend the mutation succeeded.
- Existing phone reactions and contextual handoffs regress.

The existing Base UI popover owns focus, Escape, dismissal and listener cleanup.
Web reaction state lives on the existing message/turn rows, without a second
receipt table or browser-side reaction cache.
