# Jobs and tasks inheriting chat access

Failure cases recorded before implementation and regression coverage:

- A Full or Auto origin produces an Ask job/task chat or runner turn.
- An Ask origin, including an older chat without access, inherits a more permissive installation default.
- An existing job chat without access never inherits on its next run.
- Repeated job runs overwrite explicit Ask, Auto, or Full access on the job chat.
- A deleted job chat is recreated without the origin's access.
- A missing/deleted origin makes job creation fail or changes the existing task default fallback.
- An initiative or expired-approval task inherits Full access despite its Ask restriction.
- Resuming after an expired approval fails to reset an existing Full task chat to Ask.
- Existing task chat access changes on subsequent turns.
- Project inheritance or the job's pending-turn accounting is lost.

Replay the registered backend functions through the real SQLite Runtime. Keep the
scheduler stopped and network disabled, use only synthetic records and a temporary
PERRY_HOME, and assert the access returned by the real runner claim boundary.
Each run writes a JSON report to an explicit output directory. CI retains its report;
local disposable reports and data are removed after verification.
