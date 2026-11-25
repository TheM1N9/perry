# Board attention: failure inventory

Written before isolation code. Root observed the installed Board read-only: 15 items consisted of six valid Brain approvals, two blocked decisions created after execution approvals expired, and seven unread updates (three failed tasks, one successful scheduled result, three old delivery failures). No owner data, accounts or approval outcomes are fixtures.

- Unread success/failure/delivery updates inflate Needs you and the sidebar/pet count despite requiring no decision. Moving them must preserve every record and still make updates discoverable.
- Distinct updates concerning the same thread collapse into one row; acknowledging one must not silently acknowledge another.
- Delivery updates with no chat offer only an unrelated navigation destination and no per-item acknowledgment. A failed acknowledgment must keep the update visible, and a held old acknowledgment must not swallow a newer result/failure.
- Bulk acknowledgment can clear updates hidden by search/channel filters. Only the displayed scope may be acknowledged. Legacy clients without an expected event timestamp must remain compatible.
- A task question promises Recheck/Snooze/Drop but offers only generic text input or hidden menu options. Recheck must retain the exact proposal and require a new execution approval; it must never revive expired permission.
- A native expired-approval question can embed a large original JSON request. Its concise decision explanation must remain readable, with the exact original preserved behind a disclosure rather than discarded or misparsed.
- Stale/repeated Recheck, Snooze or Drop must not affect a changed decision generation, another task, or an already resolved task. Drop must cancel through the existing task lifecycle and retain history.
- An open Drop confirmation for generation A must unmount when generation B replaces it; a reusable dialog must not silently confirm its latest action against B. A held initial inbox read must show loading rather than claiming Updates is empty.
- Snooze leaves the question answerable and recorded, but must remove it from Needs you until due. An elapsed snooze must restore attention from native time without changing the saved task. Paused goals and pending finalizers must retain their existing resume refusals.
- A valid approval outside the capped pending list appears on the Board without controls. Selected lookup must use the same expiry rules/projection and reject wrong key, missing, expired or answered rows. Execution approvals retain their shorter TTL than Brain proposals.
- A standalone native question opens an unsupported Board pane instead of its actual answer surface; question labels and navigation must remain truthful. Stopped/terminal questions must not contribute attention.
- Empty/loading/error states, narrow screens, keyboard activation and failed actions must not falsely report success or mutate unrelated records.
- Isolated harness failure, shared-build replacement, paid/provider access, browser leaks or retained scratch data must not be mistaken for a product pass. Use one fresh home/browser, fake-only records, no runner/model/account, normal teardown and a JSON evidence artifact.

Acceptance will exercise actual production browser, HTTP functions and SQLite state. Root owns UI changes; this lane owns backend guards and the preserved acceptance journey. Installed checkout is a different revision and must receive only reviewed surgical changes, never wholesale file replacement.
