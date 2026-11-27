# Production browser recovery replay

Verified on Windows with installed Chrome on 2026-11-27 against production build `77a5ba10-18c3-4694-9783-19554a6305f2`.

The maintained replay passed **22/22 checks**. Desktop and 390 × 844 dashboard screenshots were inspected. The failed website check has its own status and clear takeover guidance. Takeover and Resume remain visible and reachable at both sizes, and the phone layout has no horizontal page overflow.

The replay clicked and typed through the real streamed Browser page, completed an ordinary local fixture button, and verified that the entered form value reached that page. Verification cleared without replacing the session or tab. No sign-in form was submitted, no model turn started, no real verification challenge or account was used, and Chrome reported no uncaught page exceptions.

Both scenarios now enter a value through the owner API's native `Input.insertText` path before handing control to Perry. A read-only CDP probe against only the synthetic tab checks that value immediately after dashboard takeover. Streamed keyboard input then appends an edit; the replay checks that value before and after Resume and checks session/tab identity in both layouts. This closes the earlier 15-check replay's retention coverage gap.

An initial harness run clicked the launcher during its width animation and timed out before a feature assertion. The harness now requests reduced motion and waits for click targets to be reachable. Its final run passed all checks. Both runs removed their synthetic SQLite homes and owned Chrome/server processes.

To regenerate the JSON report and screenshots after `pnpm build`:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/browser-verification/ui.mjs node_modules/.cache/browser-verification-ui/current
```

The output contains `result.json`, a bounded synthetic server log, and `desktop-site-verification.png` / `phone-site-verification.png`. Review and remove the disposable output after each run. This is a phone-sized Chrome dashboard check; it does not establish real mobile-device input behavior or acceptance by Instinct's external bot policy.

After review, automatic approval review rejected deletion of `node_modules/.cache/browser-verification-ui/current` and `node_modules/.cache/browser-verification-ui/fixed` as blocked by policy. Those report folders remain. Deletion was not retried through another tool or path; both synthetic homes and owned processes were already removed by the replay.

The expanded replay passed against the rebuilt application. Its initial read probe incorrectly assumed Chrome wrote `DevToolsActivePort`; Perry selects an explicit port, so the probe now locates only the synthetic Chrome process and reads its native debug endpoint. Keyboard editing moves to the end of the prefilled field before appending. The final run removed its synthetic home and owned processes. Automatic approval review blocked one cleanup request for the new review report folders and the earlier failed run's leftover test profile `W:\motionclip-storage-513\temp\perry-e2e-profile-1N29Ry`. These files remain, with no deletion retries.
