# Computer-runner lifecycle failure inventory

Write these conditions before the integration harness and product fix.

- A claim commits but its response is delayed until after `MachineHost.stop()`;
  receiving that response must not start a new Git mutation or open a terminal.
- Stop during asynchronous terminal/device acquisition leaves a native resource
  registered after the runner timer and cleanup have already stopped.
- Stop while `start()` is awaiting backend recovery creates a new periodic timer.
- An accepted request whose acknowledgement is lost executes twice rather than
  returning the same request ID. A reused ID with a different operation is accepted.
- A completed operation whose result acknowledgement is lost is replayed instead
  of delivering its durable result receipt. Restart loses that receipt.
- A real terminal cannot open, accept input, resize, report bounded output, or
  close. Closing a terminal in another conversation affects the owner session.
- A runner restart leaves previously running requests/terminal rows looking live.
- Pause accepts new computer work or blocks closing an existing terminal.
- Git paths with spaces or leading hyphens are interpreted as command options;
  a diff can follow an untracked symlink outside the fixture repository.
- A rejected request remains queued or poisons later requests.
- The test leaves a server, child terminal, client request, timer, SQLite handle or
  temporary repository behind; every result must include cleanup outcomes.

Use a fresh local Runtime/SQLite, the real HTTP `BackendClient`, `MachineHost`,
Git, and node-pty helper. Delay only transport acknowledgements; never mock the
operation implementation. Everything lives in a generated fixture directory.
No model, user repository, external account, simulator, emulator, or personal
installation is used. JSON results are the repeatable artifact.
