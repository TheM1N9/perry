# Dashboard handoff replay

Build the production dashboard, then run its real Chrome flow against a disposable synthetic Perry home:

```powershell
pnpm build
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/phone-questions/ui.mjs node_modules/.cache/phone-questions-ui/result
```

The replay starts the installed Next production server on an ephemeral loopback port, uses the maintained isolated Chrome driver, and exercises the actual question form and authenticated native APIs. WhatsApp uses the existing fake driver against a local control server; it never connects to WhatsApp. No model runner starts.

The form starts with an option and a free-text answer saved from the phone. Native Chrome input clears the saved text and edits another field and option. A further phone answer arrives while the form is mounted. The replay checks that incoming answers appear, local edits survive, clearing an answer keeps Continue disabled, and finishing the form returns the complete batch to the original runner. It also checks one answer-history entry, revoked queued prompts, no new turn, and no uncaught browser exceptions.

`result.json`, `dashboard-handoff.png`, `dashboard-continue.png`, and the bounded `server.log` are repeatable evidence. The result records the production build ID and cleanup outcome. The fixture scrolls the question form to the visible Continue button and submits with native Chrome pointer events. It stops its server, Chrome/profile and fake phone, then removes its disposable SQLite home. Preserve the maintained source and remove generated results after verification.
