# UI/UX implementation

Implements the remaining findings from the [UI/UX audit](ui-ux-audit.md) and UI issues found during the project and spacing audits.

| Finding | Acceptance check |
| --- | --- |
| Pending decisions are hard to discover | Needs you is a named sidebar destination with a visible count; relevant approvals remain in their conversation. |
| First use emphasizes setup | A fresh installation can choose its engine and reach text chat without personalization, a pet or microphone. |
| Technical controls compete with writing | Access remains visible; model and effort live under labelled Reply options, with effective timing explained. |
| Blocking waits are too subtle | A waiting, disconnected or failed state shows its complete reason and an applicable recovery action. |
| Running work is hard to find | Work opens on Tasks and shows current activity; existing Plans links still work. |
| Stop and global pause have ambiguous scopes | Local controls name their scope; a visible global control explains that it stops all work. |
| Brain/Library/Work require memorizing labels | Navigation and page descriptions explain memories/notes, files and background tasks/schedules. |
| Compact controls and offscreen panels need verification | Core touch controls reach 44px, keyboard focus stays visible, and panels close with predictable focus return. |
| Approvals need clear consequences | The operation and destination remain visible; one-time approval is distinct from a persistent rule. |
| Pet opens only with a pointer | Enter, Space and pointer activate once; dragging does not activate; mid-drag cleanup removes listeners. |
| Autosave can race during navigation | A pending final draft drains through the same serial queue, using the save destination captured when edited. |
| Copy feedback and motion have lifecycle issues | Copy feedback resets when the command changes and timers clean up; navigation motion avoids animating layout. |

Before writing E2E checks, verify these failure modes: a zero count hiding a destination; expired approvals retaining a badge; an old Plans bookmark failing; permission changes taking the wrong scope; a delayed save overwriting the final draft; duplicated pet activation or a lingering drag listener; optional setup becoming required; a panel hiding the composer or losing focus; touch controls overlapping after expansion; unmount during copy; and state changes breaking at narrow widths, zoom or reduced motion.

Human familiarity, gaze predictions and preference studies remain evidence questions. This implementation does not manufacture research or treat the attention forecast as measured data. Verification uses disposable data and removes temporary tooling and reports afterward.

## Verified on 10 November 2026

All implementation rows above are complete. Production builds pass for the dashboard and public site; the backend TypeScript check and pet main-process syntax check pass. No dependency was added for this work.

219 browser assertions pass with no unexpected browser exceptions:

| Run | Passing assertions | Coverage |
| --- | ---: | --- |
| Core flows | 54 | Named/counting Needs you; approval failure/retry/acknowledgement; full destination; optional setup; reply-option timing/focus; immediate access scope; Tasks default and older active work; legacy links; global pause/cancel/resume; delayed save ordering through navigation; failed-draft recovery; text-first onboarding; composer bounds and panel close/focus at five sizes. |
| Pet, site and route sweep | 142 | Native Enter/Space/pointer activation exactly once; drag without opening; keyboard after drag; copy feedback/reset/stale completion; all 14 Settings sections, chat, to-dos, meetings, Brain, Library, four Work tabs, skills and connectors at five sizes; site layout and touch-button dimensions. |
| Blocking states | 4 | Unresponsive runner and provider-plan reset wait at 320px and desktop: alert semantics, full wrapping reason, visible border, bounded card and Stop this reply. |
| Explicit engine selection | 7 | No default engine or silent selection; Start disabled until chosen; not-ready guidance; saved engine choice; text chat reached without microphone/pet setup. |
| Updated attention forecast | 12 | Six scenario routes/heat regions, changed scroll checkpoint, isolated step, heat toggle, zoom, standalone colors and no script exceptions. |

The five layout sizes were 320px, 390px, 768px, 1024px and 1440px wide. The route sweep used 640/500/768/600/900px heights; composer/panel checks also used 844px height on the phone. Coarse-pointer emulation was enabled for the first three sizes. Shorter layouts exercise scrolling and the width available under zoom; they do not replace physical-device or assistive-technology testing.

Screenshots and JSON assertion reports were inspected during verification. Per project rules, disposable browser profiles, fixtures, scripts, screenshots and reports were deleted afterward. Existing project tests and historical evidence were preserved. The earlier spacing pass's 448 assertions are recorded separately in [spacing-audit.md](spacing-audit.md); [the 181-file ledger](spacing-coverage.md) is refreshed to this implementation.

## Repeat the verification

1. Build both apps with `pnpm run build`. Run `pnpm exec tsc --noEmit -p convex/tsconfig.json` and `node --check pet/main.js`.
2. Use a disposable Perry home and key. Seed a project with instructions, a chat with a pending file-write approval, a blocked task older than 30 completed tasks and a to-do. Start the production app with that home; never use the owner's installation as test data.
3. Visit chat, Work and Needs you. Check the named count, full operation/destination, failed answer remaining retryable, removal only after acknowledgement, default Tasks and the older blocked task. Open existing `tab=plans` and `#job-` links. Pause, cancel, confirm and resume; verify persisted state after each decision.
4. Delay the first instructions mutation in the browser, edit again and navigate through an in-app link. Confirm only one request is in flight; release it and read back the final text. Fail another save, leave and return, then save the recovered draft. Repeat a first visit with no default engine and two unavailable choices; require explicit selection before text chat.
5. At each size above, check every listed route for horizontal overflow. With touch emulation, inspect composer and site targets; open/close the chat panel and inspect focus return. Seed genuine running/queued turns, including their conversation pending-turn count, to exercise disconnect and reset-wait cards.
6. Activate the pet using native Enter, Space and pointer input; close between attempts. Drag beyond its threshold and verify it stays closed, then activate by keyboard. Copy a site command, change OS and resolve an earlier delayed clipboard promise. Its result must not mark the new command copied.
7. Exercise all six attention scenarios, all scroll checkpoints and route-step/layer controls. Keep the synthetic content and manually predicted nature visible.

## Still requires people or hardware

- First-use comprehension, Brain/Library findability and one-time versus persistent permission comprehension need observation with representative users. No familiarity with other products has been assumed as a measured fact.
- Gaze routes and heat intensity remain manual forecasts. Eye tracking or another valid study is needed to measure where people actually look.
- Physical touch keyboards, screen readers, OS display scaling and native Electron window movement/access prompts need their respective devices. Renderer keyboard, drag threshold, responsive bounds and focus behavior were exercised here.
- Provider-connected browser/account workflows need their actual services. Synthetic failures verify local recovery behavior without claiming external delivery or provider success.

The later [project follow-up](project-audit.md) implements the separate delivery, runtime, dependency, privacy and film findings.

## Follow-up, 11 November

The latest map suggestions now have corresponding product changes: the new-chat heading and composer form one task area; starter suggestions keep their footprint while a draft is entered; a pending decision has an in-chat Review anchor; file requests expose affected paths and distinguish one-time permission from a collapsed persistent rule. Access descriptions explain the actual sandbox policy. General settings exposes optional diagnostics, off by default, and Needs you surfaces failed/unconfirmed notification attempts.

The follow-up browser replay passed 29 assertions, including narrow/short layouts, both themes, stable composer geometry, approval visibility, privacy toggles and editor behavior after the Tiptap update. The editor now accepts canonical `/brain/…` links and legacy `/notes/…` links. Tables, formatting, slash commands and Markdown persisted across navigation. These checks supplement the earlier 219 assertions and do not replace its broader screen coverage.

The existing onboarding CI replay now covers the task-first welcome page before entering optional personalization. All 25 checks pass against the production build: Start chatting persists the skip without voice or profile edits; personalization remains reachable; saved answers and the returning-owner review remain covered; optional setup stays collapsed on reload and its dismissed calendar prompt stays dismissed after reopening. The replay reports no browser errors and removes its disposable home.

After integrating the newer main branch, the dashboard replay passed 34 assertions. Its five additional checks verify Riff images with the aligned Tiptap image extension, layouts at 320 and 1440 pixels, document autosave reaching the list, and Brain links redirecting to Riff. The merged production build, typechecks, frozen install and dependency audit also passed; microphone capture and provider editing were not invoked.

## Requested chat and footer revision

The greeting and headline are centered above the composer. The explanatory sentence and optional setup row are removed; starter prompts are centered below the composer and retain their footprint while typing. The unused setup-prompt component and its chat mutations are removed. Personalization remains available from welcome/settings.

The sidebar footer matches primary navigation: 2px between rows, 32px desktop rows and 44px touch rows. Pause has no extra wrapper padding or repeated scope sentence; its existing confirmation retains the explanation. Browser verification covers landing alignment in both themes at five viewport sizes, starter selection/focus, stable composer position, footer geometry, collapsed and phone sidebars, confirmation/cancel and runtime errors. Requested screenshots are retained in `artifacts/layout-adjustments/`.
