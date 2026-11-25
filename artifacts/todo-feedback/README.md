# To-do input and feedback

This permanent fixture preserves root's directly observed To-dos usability defects and the overlapping rejected-add loss reproduced independently through production HTTP. The inventory in `failure-cases.md` predates isolation code. Root owns the shared component/pet repairs; this lane changes only fixture/docs.

Root manually observed that QuickAdd had no pointer Add action, a newly added row could sort below the viewport without feedback, parsed date/repeat previews hid its Enter hint and incidental dates in QA labels could create unwanted reminders without an opt-out. Current Todoist/Mobbin references and their practical application are recorded separately in `docs/ux-reference-review.md`.

On baseline build `48d079fa-18b0-4f24-9c6f-6209f69086ec`, `--overlap-only` held and rejected two native Enter additions. Both real browser calls were recorded; neither reached SQLite. The input restored only `Unsent alpha draft`, the generic error named neither title and `Unsent beta draft` was lost. `node_modules/.cache/todo-feedback-overlap-baseline/result.json` and `failure.png` preserve this actual failed acceptance, not a successful product claim. Normal teardown removed its Temp home/profile.

The repair deliberately permits one pending addition: the exact draft remains visible until acknowledgement, the native input becomes read-only to preserve keyboard focus, and Add/correction controls are disabled while saving. A refusal preserves the original text and its per-draft literal choice. The default acceptance verifies that real keystrokes cannot alter the pending draft, Enter cannot submit again and the focused input accepts new typing immediately after acknowledgement. It verifies prevention of overlapping submissions rather than requiring concurrent capture. `--overlap-only` is a historical old-build reproduction; use the default mode for repaired acceptance.

```powershell
$env:TEMP = Join-Path $env:LOCALAPPDATA 'Temp'
$env:TMP = $env:TEMP
$env:PERRY_E2E_DIR = $env:TEMP
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/todo-feedback/run.ts node_modules/.cache/todo-feedback-final
```

The default mode uses one real production server/SQLite store and installed Chrome profile on native Temp. Playwright attaches to the existing shared harness browser. No runner, live account/provider or model download is used; the deterministic embedder and existing non-loopback fetch guard protect the isolated server.

Its 20 meaningful conditions cover pointer and Enter input, inferred dates/repeats, full literal opt-out and next-draft reset, held acknowledgements and refused saves, truthful completion/Undo, one future repeating occurrence, below-viewport confirmation, a 390px dashboard and the actual 404px `/pet` consumer's existing add/completion/problem callbacks. Successful held requests really commit through HTTP before only their browser acknowledgement is delayed; synthetic failed requests are rejected before reaching the backend. Completion calls are counted so the pet cannot silently write twice for one checkbox action.

Each run emits `result.json`, native screenshots and normal home/profile teardown evidence. Generated report directories are left in place under the current no-explicit-cleanup-retry instruction; disposable native data still uses the harness's normal teardown. This synthetic browser journey is separate from root's manual use of personal Perry on port 7377.

## Acceptance evidence

The final run passed **20/20** at `2026-11-25T11:19:30.846Z` against production build `c721f6a3-9b2a-4f53-8416-a5aa6f4e289d`, using output directory `node_modules/.cache/todo-feedback-final-native`:

- Pointer Add and native Enter each stored one intended item and confirmed the exact parsed title. Literal date/repeat opt-outs kept all original words and omitted both scheduling fields; a fresh draft parsed normally again.
- A real committed add's browser acknowledgement was held. The input remained focused and read-only, typed keys did not alter its visible draft, Enter issued no additional request, correction/Add stayed disabled and no success receipt appeared prematurely. Releasing the acknowledgement cleared/unlocked the same focused input, which immediately accepted new keyboard typing.
- A pre-commit failed addition retained its exact literal draft; retry saved it without an unintended reminder. A failed completion left its row open with error feedback and no success/Undo receipt. A held committed completion did not report success before acknowledgement; ordinary Undo reopened the original ID.
- Repeating completion kept one completed row and exactly one future occurrence, with explicit next-occurrence copy and no Undo action. A newly added row sorted below the viewport still produced a visible title-specific receipt.
- Actual viewport measurements were dashboard `innerWidth:390, scrollWidth:380` and pet `404/404`. Both screenshots were inspected: Add/correction remained available, and the pet displayed the failed draft/error without overflow.
- The actual `/pet` consumer used its existing add/Done/problem callbacks without duplicate dashboard toasts. Its successful checkbox action issued exactly one completion call; its separately injected failed completion remained open. A failed pet add preserved its draft and did not say it was added.

The report records no browser runtime errors or model turns and `tempHomeRemoved:true`; browser/server teardown completed normally. Main/artifact typechecks and `git diff --check` passed. No product source changed in this fixture lane.

An earlier repaired-build run passed all 15 dashboard cases and then stopped before pet controls because Playwright required the continuously animated Perry body to be geometrically stable for a pointer click. This established no product failure. Its diagnostic output remains under `node_modules/.cache/todo-feedback-final`. The final fixture activates that accessible button with native focus/Enter, and captures screenshots through Playwright's own viewport session. The old-build overlapping-save data loss remains independently recorded in the baseline directory above.
