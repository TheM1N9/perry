# Long-lived pet reminder failure inventory

Written before the fixture or production changes. The replay runs the production `/pet` page with a synthetic native SQLite home and native todo mutations. Browser notifications are captured in the fixture and never reach the operating system.

- Repeatedly rescheduling one open todo leaves an entry for every past due time.
- Visiting both heads-up thresholds retains past due-time and threshold keys without a bound.
- Completing, deleting or making a todo untimed leaves retained reminder entries.
- Cache pruning accidentally suppresses another still-open todo's notification or heads-up.
- An unchanged overdue todo produces duplicate system notifications on later clock ticks or board updates.
- A newly rescheduled due time fails to notify again.
- Missing or denied Notification permission prevents cache pruning or incorrectly records a notification as sent.
- A dismissed heads-up reappears for the same due time and threshold, including after another threshold or a clock rollback.
- A genuinely rescheduled todo incorrectly inherits a dismissed heads-up from its previous due time.
- A stale close callback alters or restores a newer due-time entry.
- A transient missing board response resets notification/dismissal history.
- Navigating away leaves active listeners, timers, a fixture server, a browser profile, or a disposable SQLite home.

The fixture observes only Map/Set entries whose keys match its generated todo IDs. It does not add production exports or test branches. Each run writes a repeatable JSON result and the build ID, and keeps baseline failures separate from fixed verification.

Verification-harness cases identified while building the replay: initialization of temporary iterable Maps must not count as retained ref-cache writes; an API update can render before its newly generated ID reaches the observer; fragment-only navigation does not reset a browser clock phase; dismissal assertions must wait for the native spring exit to finish.
