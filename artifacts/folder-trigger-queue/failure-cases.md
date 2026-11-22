# Folder trigger regression checks

Use real filesystem watches, the SQLite runtime, jobs mutations/actions, and
scheduled brain prompts. Stop before an engine call: completion is supplied as
NOTHING or an error, so this test cannot spend credits or notify a real owner.

Ways this can fail (recorded before implementation):

- Ten settled files in a burst lose nine filenames to the event cooldown.
- A completion marker shortly after a result is lost inside the cooldown.
- DONE.txt 30 seconds after a burst disappears while the first run is active.
- Events during a run start overlapping turns instead of one follow-up batch.
- A batch exceeding the event text limit silently truncates later filenames.
- A quiet result or a failed run never releases the folder queue.
- Queued work disappears when the runtime restarts.
- Paused, disabled, deleted, or unrelated jobs run unexpectedly.
- A file's repeated write notifications enqueue duplicates; partial files and
  files already present at registration trigger runs.
- A failed enqueue is remembered as delivered and is never retried.
- Missing/coalesced watcher notifications lose files that are still on disk.
- Shutdown leaves watchers, retry timers, or listeners alive.

Run the replay with a disposable output directory. Each run writes result.json;
temporary files and databases are removed in finally. CI retains result.json.
