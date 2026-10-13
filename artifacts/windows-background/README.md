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
- Dashboard responding before the local runner checks in; startup timeout or
  crash leaving the tray with no explanation; endless rapid recovery attempts.
- Update/recovery switching back to the old PowerShell launcher.
- A supervisor exiting while a descendant still holds stdout/stderr open:
  log-drain waits must not keep its job and orphan processes alive forever.
  Descendants must be stopped before the launcher waits for pipe EOF, and the
  supervisor's original exit code must still reach Task Scheduler.

Run `bun artifacts/windows-background/run.ts <output-directory>` on a disposable
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

`bun artifacts/windows-background/supervisor.ts <output-directory>` exercises the
real production build and runner on port 7384 in a fresh temporary home. It
checks readiness, repeated launch, crash reporting/recovery, shutdown and
foreground output, preserving JSON and lifecycle logs. It needs a local
`.env.local` with only a test dashboard key and a production build; it refuses
to use an occupied port. No service installation, engine turns or messaging
accounts are used. `supervisor-macos/` contains the successful macOS run;
`macos/result.json` explicitly records the native Windows check as skipped.

Native API references: [CreateNoWindow](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.processstartinfo.createnowindow)
and [C# output types](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-options/output).

Installed Windows verification still requires a standard non-admin account,
fresh install in a path containing spaces/Unicode, fresh and repeated desktop
launch, service stop/start, both update paths, startup/child failure and recovery,
`perry stop` then `perry run`, and shutdown with an unrelated terminal open.
Record the screen from before launch through readiness (and restart/update) to
prove there is no flash. Check tray readiness/failure and Open logs, Settings →
Computers, one runner, and logs under `PERRY_HOME/logs` throughout. Do not use a
real messaging account or credentials for this verification.
