# Board owner-control inventory

Before isolation code: use the existing production server/browser harness, one native Temp home and Chrome profile, the installed Playwright library connected to that owned Chrome, the existing fixture embedder/fetch guard, and no runner. Pause background work before creating tasks; explicit production mutations supply synthetic task transitions without any engine/provider call. Preserve all previous fixtures and shared build.

- Empty goals/tasks hide creation or imply an error. Loading is mistaken for empty state.
- Native labels/keyboard/focus or Base UI select/checkbox controls cannot create and edit a goal/task, associate a goal or select prerequisites.
- Blank/whitespace title, short task brief, missing goal/task, dependency cycle or changed task state reaches the server but loses its actionable validation message.
- Goal milestones lose their ticks when preserved by name, renamed/removed/reordered; blank lines or more than twenty are handled silently/inconsistently.
- Goal active/paused/done transitions save the wrong state, lose milestones or description, disappear irrecoverably from the correct Board filter, or fail on reopening.
- A refused/failed save clears or closes the owner's draft, creates data anyway, or retry creates duplicate rows.
- A stale open goal editor silently overwrites independently saved title/description/status/milestones. Live query refresh mutates the intended draft or advances its save base without owner review.
- Prerequisite search loses selected hidden rows, an empty search lies about available tasks, removal fails, the edited task can select itself, or a cycle/missing prerequisite is accepted.
- A queued task changes state while its prerequisite form is open; refusal loses the selections or supplies no repair action. Missing legacy prerequisite remains visible/removable.
- Global pause allows fixture work to escape into a real provider. No runner/account is started, and the server must use the deterministic embedder and deny non-loopback fetches.
- Fixture failures lose browser/HTTP/SQLite state, leave routes/listeners/processes/profile/home behind, or overwrite prior successful evidence. Save repeatable JSON/screenshots and perform normal harness teardown; never retry previously policy-rejected cleanup paths.

## Scoped search recovery (written before search-only isolation code)

Root manually observed a known completed QA task hidden by the default open tab while generic search copy implied no matching work existed. Preserve this independently as a short synthetic UI regression:

- A known completed match hidden only by the current status does not explain its scope or offer all-status recovery, despite done/all counts showing a match.
- Search all statuses changes the search/channel/sort/computer filters or is not a native keyboard-accessible link.
- Empty all-status results offer another pointless all-status search.
- No matching work in any status still offers a pointless all-status search.
- Clear search discards the current status, channel, computer or sort instead of only removing q; a nonmatching computer is falsely ignored.

Use the existing paused, no-runner production home/browser. A real task mutation plus explicit synthetic completed state supplies the known task. Positive recovery verifies q/channel/sort; the separate negative computer-scope case verifies preservation without inventing a fake execution holder. This scripted check is not another manual run against the owner's Perry.
