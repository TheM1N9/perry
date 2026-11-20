# Reactions in group and contact chats

Mani: "make sure you react to messages on groups", then "only for the ones that you got
tagged". Failure cases written before the replay:

- A group message that tags Perry's own account (WhatsApp @mention of its number, Telegram
  @mention of the bot) starts a turn that cannot react to it, or reacts to some other message.
- A WhatsApp group reaction leaves out the sender (participant), so WhatsApp cannot find it.
- A group message that only names Perry, or only replies to it, without a tag, gets a reaction.
- A group message that is not for Perry starts a turn or gets a reaction.
- A one-to-one contact's message cannot be reacted to.
- A guest turn reacts to another message id: a later message steered into the same turn,
  a message in another chat, or the owner's own chat.
- A contact blocked mid-turn (no longer allowed: Perry is silent there) or a paused Perry
  still reacts, or a reaction queued while WhatsApp was offline still goes after the block.
- An incoming reaction in a group or contact chat (WhatsApp or Telegram, from a member or
  from the owner) starts a turn, so Perry reacts back and loops; a reaction-event turn reacts.
- The guest tool list lacks react_to_message, or guest instructions do not say when to react.
- The owner's own phone-chat reactions stop working.

Replay the registered backend functions through the real SQLite Runtime, from each app's
inbound entry point (whatsapp:receiveOther, whatsapp:receive, ingest:receiveOther,
reactions:receive, ingest:handleTelegram) to the runner's claim and the react_to_message
action. The scheduler is stopped, Telegram's API is a local stub that records calls,
data is synthetic and PERRY_HOME is temporary. The run writes result.json to an explicit
output directory; CI keeps it, local runs delete it after verification.
