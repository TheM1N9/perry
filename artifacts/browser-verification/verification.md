# Browser verification replay results

Verified on Windows with installed Chrome on 2026-11-27. No Next.js build, model calls, live account access, CAPTCHA completion or SMS requests were used.

| Replay | Result | Synthetic home removed | Cleanup errors |
| --- | --- | --- | --- |
| Pre-fix sources at `e89a386f70b697fd09b34f76ad3309dd861c7d63`, final replay | 26/41 pass; 15 expected failures | Yes | None |
| Initial implementation | 27/28 pass; hidden-widget false positive found | Yes | None |
| Corrected implementation, expanded replay | 30/30 pass | Yes | None |
| Corrected implementation, earlier replay | 33/33 pass | Yes | None |
| Final implementation, including deferred execution and post-approval recheck | 41/41 pass | Yes | None |
| Initial PR sources at `17a53d0eadba322494e78a52691099dc4682ead1`, expanded review replay | 41/43 pass; 2 expected failures | Yes | None |
| Review fixes, including native image submission and changed button classification | 43/43 pass | Yes | None |

The final baseline failed default desktop launch, idle callback protection after owner takeover, verification metadata, required/failed form-submit guards, known-iframe recognition, saved-login automatic-submit protection and the post-approval recheck. Existing launch overrides, article/hidden/solved controls, field entry, explicit saved-login filling, deferred verification submission, owner controls and stopped-turn authorization passed.

The first current replay found that a hidden Turnstile widget and empty token field falsely triggered verification. The detector was corrected to require visible challenge evidence; the final replay passed that case and a visible failed check with a stale response token.

Final controls confirmed that required/failed checks stop agent form submission. Checking alone allows a submit to initiate deferred execution; the synthetic deferred widget produces a token and clears only after submitting. A visible Cloudflare iframe is recognized even without readable parent challenge copy; its external URL is blocked by the fixture CSP, so no real challenge is loaded or solved. Retry and ordinary typing remain usable. Owner completion and Resume preserve the browser session, tab and entered field value, and a fresh Full-access action submits successfully afterward.

The native vault saves an encrypted synthetic login. Default `sign_in` is blocked before the vault's `lastUsedAt` changes or its password is entered. Explicit `submit:false` fills the saved username and password, sends no form submission, and keeps the password out of its result. Snapshot text also excludes the original synthetic password and verification token.

The approval-wait regression starts with a solved page, requests a click in Ask mode, changes the DOM to a failed check without changing browser identity, and approves the pending request. The current implementation returns a fresh failed snapshot with `blockedAction:true`; the form counter stays zero. The baseline submits instead.

The review replay adds an actual `input[type=image]` and a button changed from `type=button` to `type=submit` during an approval wait. Both submit despite failed verification on the first PR commit. The fixes classify the image control and re-read the button after approval; both return `blockedAction:true` without submitting. Retry remains usable, and all earlier controls still pass.

These fixtures establish Perry's interpretation and handoff behavior. They do not prove an external site's acceptance, read cross-origin iframe copy, or cover multiple widgets and custom token-field names. A nonempty standard response can mask another pending widget; a custom response field may not clear inferred checking status.

Use the commands in README.md to regenerate the machine-readable `result.json` evidence. Each replay removed its synthetic home and owned Chrome processes. Automatic approval review rejected deletion of reviewed report directories: the five under `node_modules/.cache/browser-verification`, siblings `node_modules/.cache/browser-signin-current` and `node_modules/.cache/browser-signin-baseline`, and final siblings `node_modules/.cache/browser-final-current` and `node_modules/.cache/browser-final-baseline`. Those nine directories remain. No rejected deletion was retried through another tool or delegated to another agent.

For the review pass, deletion of the new `node_modules/.cache/browser-review-{baseline,fixed,ui,ui-fixed,ui-final}` report folders was also rejected as blocked by policy. They remain; none of the earlier rejected paths was included in that request.

## Windows dashboard replay synchronization, PR #389

Windows job `140667133454` on `0b8d2c7` timed out waiting for the browser launcher after the first panel-toggle click. Its screenshot showed a closed panel; no feature assertion had run. This was not a failed download assertion. The report did not contain the clicked page identity, coordinates or panel state, so it does not establish whether navigation or layout movement caused the missed click.

A local unchanged replay with 600 ms navigation latency passed all 22 existing checks; latency alone did not reproduce the failure. The replay now waits for the exact destination chat and document readiness, waits for fonts, moves the pointer, and checks stable, reachable button bounds after hover and scrolling before dispatching one click. Failure reports retain the missing diagnostics. No production code or assertion was removed, and no dispatched action is retried.

On production build `5ea42a8c-4853-4f63-8d07-9df3d0f38e2c`, the revised replay passed all 23 checks both at normal speed and with 600 ms latency and fourfold CPU slowdown. Desktop and phone screenshots were inspected; takeover controls and guidance were visible, with no phone overflow. Both sessions retained their tab and entered field value after Resume. No sign-in form was submitted, model turn started or real challenge completed. Both synthetic homes and owned processes were removed. Fresh hosted Windows CI remains necessary to confirm the original failure no longer occurs there.

Automatic approval review rejected deletion of `node_modules/.cache/browser-panel-{ci-389,nav-baseline,ready-389,normal-389}` as blocked by policy. These four disposable report folders remain. No previously rejected path was included, and the deletion was not retried through another tool.
