# Windows background launch (#284)

The installed path is `install.ps1` → `perry setup` → `perry start` → the per-user
`Perry runner` scheduled task. Previously that task started PowerShell with
`-WindowStyle Hidden` and then `runner.cmd`: a console could be created before
PowerShell hid it. The separate pet login entry starts Electron directly; its
single-instance lock brings an existing pet back. Restarting the pet does not
restart the service. CLI updates stop/start the service; dashboard updates and
child recovery run through the same supervisor's child-launch function.

Verification failure cases, recorded before changing the implementation:

- A GUI launcher accidentally compiled as a console application; a console child
  created without CreateNoWindow; descendants opening their own consoles.
- Incorrect quoting/encoding of spaces, apostrophes, percent signs, ampersands,
  dollar signs or Unicode; lost environment, cwd, or per-user privilege level.
- Compilation failure replacing a working install; a missing executable or
  nonzero child exit being reported as success; a launcher exiting too early.
- Repeated launches creating another supervisor/runner; stale PID files killing
  an unrelated process; foreground mode competing with an existing service.
- Unbounded logs, oversized lines, concurrent stdout/stderr rotation, credentials
  or private turn output in background logs; lost logs on startup failure.
- A read-only rotation target throwing UnauthorizedAccessException: both pipes
  must continue draining and the child's exit status must be preserved.
- Dashboard responding before the local runner checks in; startup timeout or
  crash leaving the tray with no explanation; endless rapid recovery attempts.
- Update/recovery switching back to the old PowerShell launcher.
- An isolated installed test replacing the owner's scheduled task, login entry,
  launcher or home; task-name overrides disappearing after update/restart.
- Least-privilege registration failing, duplicate service processes, stale
  supervisor PID locks after forced Task Scheduler shutdown, and a stale lock
  naming an unrelated live process blocking a fresh start.
- Native startup/stop, runner recovery, CLI update, dashboard update and failed
  update leaving the installed GUI launcher or tray stuck; no-console recording
  starting too late, or verification quietly reusing the owner's installation.
- A supervisor exiting while a descendant still holds stdout/stderr open:
  log-drain waits must not keep its job and orphan processes alive forever.
  Descendants must be stopped before the launcher waits for pipe EOF, and the
  supervisor's original exit code must still reach Task Scheduler.

Run `pnpm exec bun artifacts/windows-background/run.ts <output-directory>` on a disposable
Windows account. It compiles and runs the **actual native launcher**, using a
small console child instead of the engine/server, and preserves JSON evidence.
This checks process flags, cwd/environment/argument preservation, single-instance
behavior, exit propagation, bounded logs and launcher failure. It does not
establish installed desktop behavior or prove absence of a flash.
It also checks that terminating the launcher closes its owned process tree.

Windows review reproduced a supervisor-exit hang when a surviving descendant
kept the redirected log pipes open. The launcher now closes its owning job
before waiting for the drain tasks. The regression fixture verifies both bounded
exit with the supervisor's original status and cleanup of the descendant.
`windows-review-before-fix/result.json` records the reproduced failure;
`windows-review-after-fix/result.json` records all 16 native checks passing.
The cwd check resolves Windows filesystem paths before comparing them: CI may
supply an 8.3 alias while .NET reports its long name. The short-name reproduction
in `windows-short-path-review/result.json` passes all 16 checks and records both
names for inspection.

`pnpm exec bun artifacts/windows-background/supervisor.ts <output-directory>` exercises the
real production build and runner on port 7384 in a fresh temporary home. It
checks readiness, repeated launch, crash reporting/recovery, shutdown and
foreground output, preserving JSON and lifecycle logs. It needs a local
`.env.local` with only a test dashboard key and a production build; it refuses
to use an occupied port. No service installation, engine turns or messaging
accounts are used. `supervisor-macos/` contains the successful macOS run;
`macos/result.json` explicitly records the native Windows check as skipped.

Native API references: [CreateNoWindow](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.processstartinfo.createnowindow)
and [C# output types](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-options/output).

Installed Windows verification passed on Windows 11 with an unelevated,
medium-integrity token (Administrators is deny-only), and the real task's
RunLevel is 0. No administrative rights were used. This tests standard-user
permissions; a separate account without Administrators membership was not used.
`installed-windows-verified/result.json` records the real installer into paths
with spaces/Unicode, isolated home/task/login entry, fresh/repeated launches,
runner crash/recovery, CLI and dashboard updates, failed-update rollback,
foreground debugging, stale lock recovery, and shutdown preserving an unrelated
live process. The owner's scheduled task was unchanged. Final installed
service/supervisor file hashes match the reviewed sources (recording-review.json).

`desktop.ts` observes the actual Electron Tray/Menu objects, invokes native
Open logs, and checks the production Computers page. `desktop-result.json` and
`native-tray.jsonl` record ready/unavailable/ready transitions and the successful
native folder-open result. `computers.png` shows exactly one online Windows
runner. `foreground.ts` separately verifies exclusive ownership when the debug
command uses a relative script path; `foreground-result.json` passed.

The 30 fps screen recording spans launch, repeated launch, crash/recovery, both
updates, rollback, debug and shutdown. No console window was observed in the
reviewed recording. `startup.mp4` publishes the neutral first 85 seconds, covering
fresh launch through readiness and repeated launches. The full 703-second video
is retained locally with its SHA-256 in `recording-review.json`; later desktop
activity includes the owner's app switching and is not published. Recording is
observational evidence, alongside the GUI PE and no-console native checks.

To repeat on Windows with Bun, pnpm, Git, Chrome and ffmpeg available:

1. Run `pnpm exec bun artifacts/windows-background/installed.ts <output>`.
   It installs from a disposable local upstream, uses a unique
   `PERRY_SERVICE_TASK`, and never uses real messaging or model credentials.
2. At `recording-ready`, inspect/foreground the neutral Chrome window and create
   `<output>/recording-ready.done`. Keep it visible during the recording.
3. At `installed-ready`, run
   `pnpm exec node artifacts/windows-background/desktop.ts <output>`. It advances
   the tray/failure/update handoffs. Set `PERRY_E2E_PLAYWRIGHT` to an existing
   Playwright `index.mjs` when the bundled Codex runtime is unavailable.
4. At `recording-review`, optionally run
   `pnpm exec bun artifacts/windows-background/foreground.ts <output>`, then
   create `<output>/recording-review.done`. The driver finalizes the video and
   removes its own task/login entry. Inspect the saved video before acceptance.

The extra native permission fixture reproduced a hung launcher with a read-only
rotation target. Both IOException and UnauthorizedAccessException now leave
pipe draining active and preserve the child's exit code. The before/after JSON
records in `windows-permission-{before,after}-fix/` show the failure and all 17
native checks passing. Logs now require a full UTC timestamp ending in Z.

Post-merge CI exposed an overly expensive permission fixture: 12,000 lines caused
thousands of denied rotations on the hosted runner and
exceeded its 15-second budget. That fixture now writes 2,000 lines (still enough
to exceed the 1 MiB rotation limit and fill a pipe if draining stops), records
its actual result/duration, and allows 30 seconds. The log starts empty so denial
always tests pipe draining rather than an incidental startup rotation. The
normal rotation fixture still writes 12,000 lines and checks all retained logs.
