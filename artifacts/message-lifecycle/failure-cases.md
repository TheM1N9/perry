# Message lifecycle failure inventory

Recorded before implementation and the E2E harness.

- An accepted send exists only as scheduled preparation; Stop and Remove miss it.
- Two preparations finish out of order, reversing the owner's queue.
- A follow-up accepted before a turn starts steers it later, instead of waiting.
- A follow-up intended for turn A steers turn B after A finishes.
- Explicit Queue is ignored while a reply runs; implicit steering loses files.
- A cancelled preparation reports late success or failure and resurrects work.
- Stop in one chat affects another chat; a normal completion or error arriving
  after Stop overwrites the stop or starts a routing retry.
- A pending steer rejected after Stop becomes runnable again.
- Multiple steering preparations complete out of order or their media localizations
  overlap, reversing updates; a busy runner hides another runner's pending steers.
- Pause misses preparing sends without an assigned runner, then Resume starts them.
- Preparing reservations consume extra queue slots, bypass the limit, or leak
  pending counts. Equal timestamps allow later messages to claim first.
- Attachment validation admits missing, foreign, removed, duplicate or excessive files.
- A preparation is abandoned by a server restart and blocks the chat forever.
- Double submit creates duplicate work; upload errors erase the draft or overwrite
  newly typed text. Navigating between chats sends or restores to the wrong chat.
- Stop during a media upload interrupts the old reply but lets the pending upload
  submit a new message afterwards; aborting a partial batch leaks blob previews.
- Stop disappears while typing a follow-up; Queue and Send have ambiguous labels.

Use production dashboard mutations, Runtime/SQLite, durable scheduled arguments,
handoff, authenticated fake runner reports and real history finalization. Keep
the scheduler stopped and invoke only the selected scheduled calls: no real
models, Telegram or WhatsApp. Each run writes a JSON artifact even on failure.
