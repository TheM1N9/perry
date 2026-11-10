When a background task requested Claude Opus with high thinking, its automatic turns honored that selection, but the task chat displayed the installation's Codex default. Sending a reply there could queue Codex with low thinking.

This change resolves task chat controls and direct replies through the same routing used by the scheduler. Deliberate model and thinking overrides apply to later task turns, while usage-limit fallback stays temporary. Sending an existing chat no longer persists a displayed inherited selection as an owner override. Explicit model/thinking defaults are preserved, and older chats without selections work without a migration.

Validation: production build and TypeScript, the task-chat production-backend/browser regression suite, and all 37 existing main-agent recovery cases. Verification uses synthetic runner metadata and no paid model calls. Reproduction, failure inventory and repeatable commands are under artifacts/task-chat-model.

Existing stored chat choices are preserved because older accidental defaults cannot be distinguished safely from intentional choices. The running Perry installation has not been updated; installation is left to the owner.
