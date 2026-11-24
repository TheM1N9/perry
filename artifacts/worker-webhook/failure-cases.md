# Worker completion failures

The replay uses a real HTTP listener, CLI subprocesses, SQLite transactions and the
persistent scheduler. It inspects the reserved turn and brain handoff without
calling a paid engine. Each run writes result.json to its supplied output folder.

- Missing/wrong authentication, cross-site requests, malformed/oversize JSON.
- Scoped token changes name, path, question, event or destination; expired token;
  token cannot call the admin API or register another worker.
- Missing, non-file or oversize result; no successful event before a file exists.
- Concurrent/repeated completion, lost HTTP acknowledgement, server restart and
  changed payload reusing an event id must not create another turn.
- Origin chat stays selected even when another chat is active; deleted origin
  falls back to the owner's main messaging channel, then web dashboard.
- Guest registration is refused and guest destinations cannot receive results.
- Busy origin steers the running turn, retaining hidden/outside provenance even
  if the engine queues it instead; worker text must never authorize outward writes.
  Full queue or pause leaves no partial event
  and the same event can be retried once admission succeeds.
- Queued preparation survives restart; completion includes the result's actual
  text, its path, worker name and reporting question with outside provenance.
- Shell quotes/spaces/metacharacters survive the generated last-step command.
- Receipt reads can fail after HTTP headers; retry the same accepted event.
- Mixed job/task origins and cycles must reach an owner destination. Commands
  too long for the launcher must be refused before a registration is saved.
- CLI errors exit nonzero without printing the dashboard key or worker token.
- Import/setup failures must leave a failed result.json with the failure detail,
  even before an HTTP listener or SQLite runtime exists.

Manual model verification remains separate: the replay proves the actual file
snapshot and reporting instruction reach Perry, not what an engine will write.
