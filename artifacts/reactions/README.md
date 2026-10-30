# Phone reactions

Run with installed dependencies and Node 25:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/reactions/run.ts
```

The journey runs the production SQLite runtime, MCP tools, WhatsApp connection
loop, Telegram ingestion, and turn finalization with fixture transports and
engine responses. No real channels, installed Perry, or models are used.
`result.json` and `transports.json` are repeatable evidence.

Failure cases recorded before writing the journey:

- Native incoming/outgoing message ids are lost or assigned to another chat.
- A reaction targets another account, a guest chat, or a guessed unknown id.
- Progress changes add text replies instead of replacing a native reaction.
- Emoji choices are restricted to hardcoded example statuses.
- Removal does not send the platform's empty reaction representation.
- A superseded failed WhatsApp reaction is retried after a newer progress update.
- WhatsApp's raw reaction upsert consumes an event before messages.reaction sees it.
- Self-chat echoes trigger feedback turns or an unbounded reaction loop.
- Owner feedback loses the target message's text, or changes/removals are ignored.
- Duplicated or out-of-order feedback repeatedly wakes the model.
- Foreign users' reactions reach the owner's session.
- A reaction becomes an approval to send, spend or delete.
- Successful reaction-only turns become empty-reply errors or send NO_REPLY.
- Failed reactions can hide an unanswered request behind NO_REPLY.
- Streaming sends the sentinel or leaves an unfinished Telegram draft behind.
- Reactions run after Stop/Pause or a background job can send one.
- Native receipt state grows forever instead of being replaced and expired.
- Stopping the WhatsApp loop leaves listeners or timers running.

Receipt context retains up to 14 days and expires in bounded batches. Reactions
are not copied into the owner's long-term memory as new instructions.

Telegram permits the bot to set one supported reaction per message. Incoming
reaction updates require explicit subscription and administrator permissions
in the chat. Private-chat feedback is therefore not guaranteed by the Bot API;
the fixture verifies handling of delivered events, not delivery availability.
See [Telegram's update contract](https://core.telegram.org/bots/api#update) and
[reaction method](https://core.telegram.org/bots/api#setmessagereaction).

In WhatsApp's Message yourself mode, Perry and the owner share the same
WhatsApp identity. Echo filtering distinguishes Perry's updates from feedback;
the platform still has a single reaction identity for that account.
