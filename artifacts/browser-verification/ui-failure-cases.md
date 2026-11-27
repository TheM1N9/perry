# Browser verification dashboard failure inventory

Written before the production dashboard replay. The replay uses a new SQLite home, a local synthetic verification page, the real owner browser API, and a separate Chrome instance displaying a production Next.js build.

- The stream omits a failed website check or presents it as a browser disconnect.
- The failed-check banner or existing takeover control is absent, obscured, or unreachable.
- Pause & take over fails to change browser ownership, or Resume acts on an old browser identity.
- The streamed browser page cannot deliver owner pointer input to a local verification control.
- Taking control, completing the synthetic check, or resuming replaces the session/tab or loses entered form data.
- The banner remains after a new state reports verification complete.
- A phone-sized dashboard hides recovery guidance or controls, or creates horizontal overflow.
- The page submits a sign-in form or starts a model turn during verification recovery.
- A failed assertion leaves a dashboard process, Chrome instance, local fixture server, database, or temporary profile running.

The fixture completes only its own ordinary local button. It does not solve a real CAPTCHA, access an account, request SMS, or use the owner's browser/profile. Each run ends with JSON checks and dashboard screenshots and removes its synthetic home and owned processes.
