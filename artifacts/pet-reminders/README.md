# Pet reminder retention replay

Build the production app, then run the real pet page against a disposable native SQLite home:

```powershell
pnpm build
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/pet-reminders/run.mjs node_modules/.cache/pet-reminders/result
```

The fixture uses native todo add, edit, complete and remove mutations. Its Chrome instance loads the actual `/pet` page and captures system notifications with a fixture-only `Notification` class, so no real desktop notifications are sent. It advances the pet's existing second callback without adding product timers or waiting through hours of reminders. A fresh page separates the long notification-clock phase from the heads-up UI phase.

The browser probe observes relevant Map/Set writes after construction and filters the recorded entries by synthetic todo IDs. It ignores iterable Map initialization, so temporary board lookup maps are not counted as retained caches. The probe adds no product exports or test branches. A stale Hide callback is obtained from the actual React DOM button props; the installed React DOM source names that property with the `__reactProps$` prefix.

`result.json` records the production build, all assertions, notification count, retained cache entries and cleanup. `server.log` stays bounded and `pet.png` captures the ending page. The fixture stops its Next server and Chrome/profile, then removes the synthetic native home. It starts no model runner and sends no real phone messages. Preserve the maintained replay source and remove generated results after verification.
