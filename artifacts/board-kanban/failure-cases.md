# Board Kanban failure inventory

Written before implementing the native production-dashboard replay.

Column color verification: all six headers must remain distinguishable in each theme; heading/count text must meet 4.5:1 contrast on its rendered surface; labels and status icons must remain present; tinting must not obscure card text, focus indicators or mobile controls.

Review regressions to reproduce through the same native browser replay:

- A queued chat between tasks with queue positions makes the comparator non-transitive, leaving a later task ahead of the next one.
- A working or completed parent with a waiting child appears outside Needs you, making that column disagree with its attention count. Keep one parent card, its real execution state and the actionable child.
- Started, commentary and finished events from runs in provider-agent conversations refer to an unlisted run thread and disappear from Activity. Preserve those events on the existing agent thread without adding duplicate root cards.

- The default layout does not expose Kanban, or changing layouts loses search, source, computer, status, sort or the selected thread.
- A card appears in the wrong live state, or an informational update or passive waiting item is presented as a decision needing the owner.
- Live task progress leaves duplicate cards, loses the card between states, or requires a page reload to reflect the native backend state.
- Search misses a child agent or project/machine context, duplicates the child as a top-level card, or cannot return to the unfiltered view.
- A channel/project or computer filter exposes another scope or loses its selection on detail navigation.
- Cards cannot open the existing thread pane, the correct next action is missing, or closing a pane loses filters and layout.
- A keyboard user cannot reach and activate cards or dismiss the overlay, or focus is trapped behind it.
- Closing details loses focus when live work no longer matches its filter; it must return to the source card when present or the board search when that card disappears.
- More than one page of work disappears, one busy column prevents another from loading, or the initial mounted DOM is unbounded.
- Empty and loading states falsely look like completed work, conceal recoverable filter results or cause horizontal page overflow.
- A phone-sized viewport hides controls or creates page-wide overflow; opening and closing detail obscures content or focus.
- List and activity views regress, or old thread/status deep links stop opening the expected content.
- Verification starts a model/provider call, touches the owner's Perry home/profile/data, or leaves processes, Chrome profiles, local servers or synthetic data behind.

Use the real SQLite Runtime and HTTP dashboard calls with synthetic records, a compiled production Next server in a disposable home and an isolated Chrome profile. Record repeatable JSON checks and screenshots. Do not mock the board DOM or mutate the owner's installation.
