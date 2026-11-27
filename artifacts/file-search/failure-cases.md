# Files search failure inventory

Recorded before the implementation and native replay. Use a fresh SQLite home and synthetic workspace files; no owner data or model calls.

- The sidebar Files surface has no labelled, keyboard-accessible search field or clear action.
- Searching checks only the current 50-file page and misses matching names farther into the selected chat/project workspace.
- Names fail case-insensitive or multiple-word matching, or clearing a query leaves pagination on an old cursor.
- Search leaks unrelated chats, projects, private contact files or hidden files, or ignores the selected type and working-file controls.
- A rejected contact association or a nonmatching filename causes native filesystem work before filtering.
- A sparse search with working files excluded repeatedly rehydrates earlier membership pages instead of using native pagination limits.
- Matching files remain hidden inside groups collapsed before the search.
- Search is lost on returning from a preview, or results from a previous scope appear in a different chat/project.
- Empty results offer no useful recovery, Enter submits the chat, Escape closes the panel before clearing, or the clear action loses input focus.
- The search field or controls overflow a phone-sized panel, or typing/unmounting creates listener/timer leaks.

Finish the native backend and production Chrome replay with JSON evidence and screenshots. Remove synthetic homes and owned processes and review disposable reports before cleanup.
