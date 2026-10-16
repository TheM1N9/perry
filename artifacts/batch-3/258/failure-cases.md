# #258 verification failure cases (before implementation)

Coordinator owns the fake browser/reconnect E2E. Failures to cover:
- Equal compiled identities show no notice; stale tab vs changed running server shows one notice.
- A matching version after rollback dismisses the toast; unknown/missing identity suppresses it.
- Development and older unversioned builds never show false mismatch notices.
- Remote branch/latest SHA or an on-disk build prepared before restart must not count as the running server identity.
- SSE reconnect must refetch status; disconnect/network failures retain existing cache without reload or a new polling timer.
- Repeated query notifications/renders and Strict Mode cleanup must not duplicate notices.
- Dismissal must remain dismissed until the server identity changes; equality must remove it.
- Incoming version changes do not reload, remount the composer or modify a draft; only owner action reloads.
- Refresh keeps the current URL and does not trigger update/service operations; stale asset caching cannot create an automatic reload loop.
- Missing/invalid dashboard keys cannot read the identity through status.
- Build config serializes one opaque build token into client and server code; it does not regenerate at server start or read mutable git/filesystem state.

Limits: draft text remains in memory until the owner explicitly refreshes. Existing composer does not persist drafts through a full reload; toast copy must advise finishing drafts first. No new persisted chat/secret copies are introduced.
