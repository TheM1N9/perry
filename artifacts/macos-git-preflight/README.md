# macOS installer Git preflight

macOS can expose a Git placeholder before Command Line Tools are installed.
The installer previously accepted its presence on PATH and masked the failed
`git --version` exit status with a pipeline to `sed`. It now checks that status
directly and stops with actionable guidance before dependency installation.

Reproduce the isolated whole-installer checks from the repository root:

```powershell
pnpm exec node artifacts/macos-git-preflight/run.mjs
```

`baseline.json` records the four broken-Git failures before the fix.
`result.json` records all eight passing scenarios after the fix: macOS/Linux,
broken/working Git, and full/pet installs. Working scenarios also rerun the
installer and verify the update path. Broken scenarios verify an early exit,
guidance, and no clone, download, dependency install or profile writes.
Shell syntax and `git diff --check` also passed.

These checks execute the actual installer with stand-in executables under Git
Bash on Windows. They simulate macOS's Git failure; an actual macOS installation
and Apple's installation dialog were not exercised. Each corrected run writes
approximately 65 KB of disposable fixtures under `.batch-work/macos-git-preflight`.
The harness resets PATH inside the shell, verifies executable resolution, and
uses a nonexistent local repository as a fail-closed network guard.

## Aborted initial harness and cleanup limitation

The initial harness lacked the internal PATH reset. Git for Windows prepended
its real Git executable and the run unexpectedly downloaded disposable clones.
That run was stopped and ordinary fixture files were removed. Automatic approval
review blocked removal of the remaining read-only Git packs, without a more
specific reason. Approximately 741 MB (48 pack/index/reverse-index files) remain
in the ignored directory:

```text
W:\Developer-w\m1n9\perry\.batch-work\macos-git-preflight\run-yLW0WM
```

This directory belongs only to the aborted test. Installed Perry, personal data,
configuration and services were not accessed or changed. The later baseline and
passing runs used the corrected, guarded harness.
