# WhatsApp and Telegram conversation handoff

Run from the repository root with Node 25 and installed dependencies:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/channel-handoff/run.ts
```

This runs the real SQLite backend, owner tools over MCP, inbound channel
handling, engine turn preparation and reply delivery in an isolated home.
WhatsApp messages remain in the fixture outbox and Telegram's HTTP transport
is stubbed. The engine response is a fixture; no model or real account is used.
`result.json` records checks and `turns.json` records the prepared follow-ups.

Failure cases recorded before writing the journey:

- Only the preferred messaging app is recognized when both are paired.
- Resumed engines keep stale connection or channel information.
- "Send this to me" requires a phone number or is routed as a guest contact.
- Sending to WhatsApp instead targets Telegram, or vice versa.
- Handoff creates a new destination chat and loses its earlier messages.
- A follow-up reaches the engine without the message and relevant source context.
- A fresh engine session loses the context after transient notes are consumed.
- A resumed engine session misses context sent outside its native session.
- A normal reply goes to the source app instead of the destination app.
- A queued WhatsApp message is reported as delivered.
- Quiet hours or the proactive daily limit delay an explicit owner request.
- An unpaired app silently falls back to another app or changes pairing.
- A guest, background job, paused turn or outside content can use the tool.
- A same-app send duplicates a normal reply.
- Unrelated source messages are copied along with the requested handoff.

The production installed Perry is never started, stopped, updated or used.
