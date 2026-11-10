# Failure inventory (written before isolated E2E source)

- Producer chooses the wrong code for offline runner, old engine, engine plan limit,
  idle watchdog, maximum runtime watchdog, empty completion, interrupted restart,
  or an unclassified engine failure.
- A producer overwrites an explicit engine code by inspecting misleading detail.
- Missing/unknown legacy codes throw, disappear, or infer misleading guidance from
  words such as runner, computer, offline, limit, or "too old for Perry".
- Code is dropped by action errors, finishTurn validation, saved runner result
  replay, retrying turns, recovery, finalization, joined-steer runs, or run queries.
- Failure persists only on a turn and never its run, or a successful/stopped turn
  inherits a prior failure; stopped/checkpoint/compact/media-only completion is
  incorrectly classified as empty_reply.
- Partial text or files are lost on failure; a failing turn is automatically
  retried despite already producing text/files/tools or accepting a steer.
- A limit cannot retry after code propagation or a generic error retries as a limit.
- Error detail is truncated before redaction or contains stored credentials;
  legacy persisted detail is delivered unredacted during finalization/query.
- Dashboard and Telegram disagree, parse regex on detail, fail on missing details,
  or leak errors into guest chats.
- Failures vanish when a newer run succeeds; duplicate prompts associate an error
  or retry with the wrong run; historical retry silently targets the latest prompt.
- New optional fields reject old persisted documents or old runner finish payloads.
- Error component hides guidance in color alone, details cannot be opened with a
  keyboard, retry stays enabled while busy, or long detail causes horizontal overflow.
- Repeated finalization saves/delivers duplicate messages or code changes.
- Test imports read installed credentials, start a real engine, call the network,
  start a scheduler, or write state outside the scratch home.

The E2E below exercises the real runtime, SQLite persistence, finishTurn,
finalizeTurn, dashboard queries and Telegram formatter/delivery with a fake engine
and an in-process fake Bot API. It intentionally leaves runner process watchdog
timing and browser interaction to the coordinator's single integrated E2E run.
