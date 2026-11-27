# Browser verification failure inventory

Written before the maintained replay and production changes. The replay uses Perry's real browser library, native SQLite Runtime, authenticated MCP endpoint and owner control API against a local synthetic site. No real CAPTCHA, account, SMS, owner browser profile or paid model is used.

- An agent conversation launches headless although the local desktop can show a regular browser.
- Explicit `PERRY_BROWSER_HEADED=0/1` or an explicit panel-only choice is ignored.
- A public reader silently changes its launch mode or borrows an owner's profile.
- An automatically opened desktop browser retains a profile indefinitely after the agent stops using it.
- A scheduled idle close acts after the owner takes control or closes a newer browser generation.
- A known failed site check is returned as ordinary page text instead of structured verification status.
- A normal article mentioning Cloudflare, a hidden widget, or an already solved widget is falsely reported as blocked.
- A checking widget never clears in a later observation after the synthetic site produces its token.
- A visible failed check with a rejected or stale response token is incorrectly treated as solved.
- Failed or required checks still permit agent form submissions, while Retry or normal field entry is incorrectly disabled.
- A checking widget that defers execution until form submission is blocked indefinitely before it can start.
- A visible Cloudflare iframe with no parent verification text is missed because its cross-origin contents cannot be read.
- Saved-login sign-in bypasses the submit guard or reveals a vault secret before rejecting a failed site check.
- Explicit saved-login `submit:false` cannot fill a failed-check form, submits it anyway, or exposes the saved password in a snapshot.
- A page that becomes verification-failed while a submission awaits approval is submitted after approval without rechecking the live page.
- Tokens, cookie values or private entered field values leak into challenge status.
- Host status and MCP snapshots disagree about the current verification state.
- Owner takeover/reply completion discards the same page, entered form values or browser session.
- Old identities or stopped turns can still click after recovery; owner takeover is bypassed.
- Browser failure is confused with a site challenge, hiding an actual disconnect.
- A failed assertion leaves Chrome, an HTTP server, timers, a synthetic database or a temporary profile running.

Each replay writes incremental `result.json` evidence with build-independent native behavior and cleanup status. Maintained sources remain in the repository; disposable homes and owned browser processes are removed.
