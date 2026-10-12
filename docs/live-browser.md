# Live browser and selected session import (#286)

## Design

Reuse the existing Chromium CDP host. Native embedding cannot work in the web dashboard across local and remote installations; authenticated, uncached image frames plus a small allowlisted input protocol show the exact selected CDP target without embedding arbitrary sites. Frames are ephemeral and never enter chat/media storage. This first transport polls at a bounded rate; it is intended for observing and taking over, not video playback.

Each owner chat has a separate persistent Chromium profile. A session generation, selected target and revision bind every agent action to the page it observed. Takeover invalidates outstanding leases, stops loading and prevents queued/late commands, including commands waiting for approval. Explicit resume creates a new revision. There is no automatic resume on panel close, disconnect or reload. Host restart reports a new generation/lost tabs; cookies persist. Guest/contact chats cannot use this host.

## Implementation plan and failure cases

1. Scope existing browser tools, add identity and server controller checks. Verify overlapping tools, stale refs, takeover during navigation/approval, popup selection, host exit and chat isolation.
2. Add an authenticated same-origin route and BrowserPanel for #285's shared WorkspacePanel. Verify wrong key, guest chat, insecure remote transport, stale frames, reconnect, keyboard and narrow screens.
3. Import only owner-selected Firefox profiles/sites locally. Read cookies.sqlite read-only, reject locks/incompatible schemas/partitioned containers. Values remain inside local code and CDP, never API responses/model/logs. Verify expired, unsupported, replace confirmation, partial rollback, removal and malicious echo.
4. Use a real local test website and throwaway profiles/accounts, record a JSON report and screenshots. Never inspect or import the owner's credentials.

Separate release flags: PERRY_BROWSER_VIEW=1 and PERRY_BROWSER_IMPORT=1. Import also requires a loopback dashboard connection on the actual host; remote import is disabled. Existing dedicated-browser tools keep working with the view disabled.

## Integration with #285

`BrowserPanel({ conversationId, onClose? })` is self-contained. Supply it as the optional `browser` ReactNode on `WorkspacePanel`; the shared shell owns visibility, resize and expansion. Completed downloads are registered through `library:add` with the conversationId, which derives project provenance and workspace relevance. No global Library feed is used.

## Supported import boundary

Firefox is the first adapter. Chromium/Safari protected databases are intentionally unsupported. Firefox cookies.sqlite is an OS-permission protected local SQLite database; Perry opens it read-only while Firefox is closed. No keychain extraction, entire-profile copy, passwords, extensions, history, localStorage, IndexedDB or background sync. Firefox session-only cookies may not be in the persisted database. Containers and partitioned cookies are reported unsupported, never flattened. Cookies are set through Chromium's supported CDP cookie interface and retain host/domain, path, Secure, HttpOnly, SameSite and expiry. Firefox schema 16/17 expiry is milliseconds; earlier supported schema 14/15 uses seconds. Authentication is reported as requiring owner inspection, never inferred from successful cookie copying.

References reviewed: [Mozilla cookie storage source](https://github.com/mozilla-firefox/firefox/blob/main/netwerk/cookie/CookiePersistentStorage.cpp), [Mozilla cookie definitions](https://github.com/mozilla-firefox/firefox/blob/main/netwerk/cookie/nsICookie.idl), [CDP Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/), [CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/). Next.js route/client guides were read from the installed 16.3.6 package before implementation.
