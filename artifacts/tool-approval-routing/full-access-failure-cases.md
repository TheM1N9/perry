# Full access without repeated permission prompts

Recorded before extending the synthetic end-to-end journey or implementation.

- A live Full owner turn still waits on an external confirmation-only tool,
  a browser step marked explicit, or first contact delivery.
- A pending tool/browser request remains pending after the owner switches to Full.
- Full access in one chat grants a different chat, guest, stopped turn or replaced
  native turn access.
- A Full first-contact send silently grants permanent inbound/outbound contact
  permission, or bypasses an owner's explicit block.
- A structured form, URL sign-in or identity challenge receives fabricated data
  merely because Full access was selected.
- The Claude SDK auto-declines elicitation because its supported callback is
  omitted; a request waiting across Stop or an access change is misapplied.
- Ask and Auto lose their existing confirmation, review or decline behavior.
- Full-access instructions continue telling the model to ask for tool consent.
- Native protocol acceptance is session-wide and survives access downgrade.
- Full access silently rejects native filesystem/network scopes merely because
  their complete JSON exceeds the phone's 800-character approval display limit;
  Ask/Auto accidentally receive an invisible oversized grant.

Use production adapters/runner dispatch and real backend mutation/query handlers
with disposable SQLite and synthetic turn/request metadata. Block all network
and never launch a paid model, native agent or real message. Save a repeatable
JSON result, including baseline failures and teardown; remove disposable output.
