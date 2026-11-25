# To-do feedback and input acceptance

Written before implementation and isolation code, after root's direct Chrome walkthrough and current Todoist/W3C references:

- Quick-add cannot be submitted with a pointer; its Enter instruction vanishes when a time or repeat is parsed.
- A successful addition below the viewport has no perceivable confirmation, encouraging a second submission.
- A literal date or recurring word in a task title cannot be retained without accidentally scheduling a reminder.
- Treating a parsed draft as text loses its original words, leaks into the next draft, or resets incorrectly after a failed save.
- Pointer submit and Enter produce different titles/dates or duplicate a task; an empty form dispatches anything.
- Acknowledging one submitted draft clears newer typing; a failed request replaces newer text or reports success.
- Two overlapping failed additions retain only the first restored draft and silently lose the second submitted title; each failed title needs visible recovery.
- A native read-only pending input still admits edits/Enter/double-click submissions, loses focus, clears its draft before acknowledgement, or leaves controls locked after a refusal. A single pending operation is the chosen recovery policy; keyboard focus must allow immediate typing once acknowledged.
- Completion feedback appears before the server confirms the write, or a failed completion offers an undo for an operation that never happened.
- Undo completes again, restores another task, duplicates records, or hides its own failure.
- The pet's existing success callbacks receive duplicate notifications, run on failed writes, or lose their behavior.
- The shared row saves a completion and its pet callback repeats the same completion mutation; one checkbox action must write completion once.
- The added controls overflow a narrow dashboard or pet, shrink pointer targets, remove focus, or leave timers/listeners after unmount.
- The fixture reaches a real account/model, downloads assets, leaves its browser/home/server, or accepts a model statement instead of actual stored state.
