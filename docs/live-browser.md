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

Firefox is the first adapter. Chromium/Safari protected databases are intentionally unsupported. Firefox cookies.sqlite is an OS-permission protected local SQLite database; Perry opens it read-only while Firefox is closed. No keychain extraction, entire-profile copy, passwords, extensions, history, localStorage, IndexedDB or background sync. Firefox session-only cookies may not be in the persisted database. Containers and partitioned cookies are reported unsupported, never flattened. Cookies are set through Chromium's supported CDP cookie interface and retain host/domain, path, Secure, HttpOnly, SameSite and expiry. Only Firefox cookie schemas 16 and 17 are accepted; both store expiry in milliseconds. Older/newer schemas are refused rather than guessed. Authentication is reported as requiring owner inspection, never inferred from successful cookie copying.

References reviewed: [Mozilla cookie storage source](https://github.com/mozilla-firefox/firefox/blob/main/netwerk/cookie/CookiePersistentStorage.cpp), [Mozilla cookie definitions](https://github.com/mozilla-firefox/firefox/blob/main/netwerk/cookie/nsICookie.idl), [CDP Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/), [CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/). Next.js route/client guides were read from the installed 16.3.6 package before implementation.

## Data, recovery and rollout

Profiles live in `PERRY_HOME/browser/chats/<sha256(chat id)>`. This is a new chat boundary; the legacy shared `browser/Default` profile is not copied. Chromium owns credential encryption and persistence with its normal OS integration; Perry never disables protected storage or writes plaintext cookie exports. Pause and capture settings persist in a mode-0600 metadata file and survive server restarts. Source import is a snapshot. The metadata manifest stores only domain, source profile label and import time; authentication still requires owner inspection. Individual removal deletes that domain's destination cookies without changing Firefox or revoking the website's original session. Website local storage created during manual use stays in the destination profile; it is never imported by this adapter.

Viewing uses the single installation's owner key. Pet keys, foreign origins, contact chats and stale/cross-chat target identities are denied. Remote viewing requires HTTPS; local HTTP is accepted only for loopback hosts. Remote import is disabled, including proxied requests carrying a non-loopback client address. A reverse proxy must preserve Host/Origin and its real forwarding headers. Do not expose a trusted localhost proxy as a remote credential-import endpoint. Multi-owner hosting is unsupported by Perry's existing single-owner dashboard.

Live frames remain in memory and the unlocked dashboard; they are not put in Library or traces. Manual takeover/import/saved sign-in blocks agent screenshots and step previews until the owner deliberately re-enables them. Browser text results redact current cookie values, including a hostile page echoing them. This is not whole-page sanitization: account details, website content, downloaded files, images and other secrets can still be visible. Owner screenshots and deliberately re-enabled agent screenshots may show sensitive page content. Uploaded files and completed downloads enter only their chat/project Library pipeline. Browser-generated filenames are GUIDs on disk; displayed names are separate, and known cookie values in download metadata are redacted before registration.

## Validation

`pnpm dlx tsx artifacts/live-browser/run.ts` exercises the real installed Chromium, local test website/account, actual dashboard route handlers, SQLite backend, actual browser tool ActionCtx and approval mutations. It writes `artifacts/live-browser/report.json` and a test-page image. `PERRY_BROWSER_FIXTURE_SCHEMA=16` checks the other accepted Firefox format. The test-only Firefox SQLite fixtures are not evidence of compatibility with a real installed Firefox profile. Both schema fixture runs passed all 14 journeys; `pnpm run typecheck` and the production build passed. Desktop and 390px mobile production-dashboard checks use the real same-session view and save `dashboard-desktop.png` / `dashboard-mobile.png`.

The portable official Firefox build could not launch on this macOS host: it reported `sandbox_extension_issue_file_to_process failed ... Operation not permitted` and `Could not find profile folder` even for a created disposable directory and a neutral `/private/tmp` working directory. OS protections were not changed. Real installed-Firefox/test-account validation, protected-storage permissions across platforms, HTTPS reverse-proxy deployment, and other browser families remain unverified. Import stays off by default and should remain off in a release until the supported installed-profile combination passes that check. To repeat it on a permitted host, set `PERRY_TEST_FIREFOX` to an official Firefox executable; the harness creates a disposable profile and account and never reads the owner's profiles.
