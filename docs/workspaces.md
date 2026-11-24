# Browser profiles and computer panels

Restart the dashboard and each connected runner after updating. The added tables
and project fields are created by the existing backend startup; no manual data
migration is required.

## Reuse browser sign-ins

Open Browser, then **Browser actions → Profiles & connections**. New chats use
the **Personal** profile. Choose another saved profile and **Use here** to reuse
its cookies, site storage and sign-ins. A profile has one Chromium process at a
time: transferring it closes its browser in the previous chat and pauses browser
automation there. Open the browser here and explicitly resume Perry when ready.
Use different profiles for independent browsers at the same time.

Existing chat profiles remain selected as **This chat only**. Create a named
profile while that profile is selected to make its existing sign-ins reusable.
The legacy Chromium directory stays at its original path; a registry associates
the saved profile with it. Creating a profile from Personal or another named
profile creates an empty profile.

Profiles persist in the dashboard host's `PERRY_HOME/browser`. They are not
synced between separate Perry installations. Normal close and transfer use
Chromium's graceful shutdown so it can save cookies before another chat opens
the profile. This retains the installed browser's normal site behavior; website
sign-in restrictions and challenges can still apply.

## Project folders and worktrees

A project's first computer operation or agent turn binds it to that computer.
All its chats start in `PERRY_HOME/workspaces/<project-id>` by default. Other
projects get different directories. A disconnected computer does not silently
move a project's checkout to another computer.

In a project chat's Terminal or Git review panel, expand **Workspace** to select
a computer and an existing absolute folder, or create a Git worktree with a new
branch and base reference. Worktrees are created under
`PERRY_HOME/worktrees/<project-id>`. Existing directories and branches are never
overwritten or removed. Git worktrees share Git's object database and have
separate checkouts and indexes.

Finish replies and computer operations, and close the project's terminals before
changing its workspace. Configuration blocks new project work until its result
is recorded. A queued configuration can be cancelled before the runner claims
it. Moving a chat between projects clears its native engine session so the next
turn starts in the destination workspace with portable conversation history.
These directories determine the checkout and working directory; engine access
settings continue to govern filesystem permissions.

## Terminal, Git review and Devices

Open these surfaces from the chat panel's picker:

- **Terminal:** xterm connected to a real PTY on the selected computer. Windows
  uses PowerShell and ConPTY through a Node helper, including when the main
  runner runs under Bun. It supports input, resize, reconnecting to a running
  terminal and explicit close. Up to four terminals run per computer. Output
  buffers and ended-session history are capped. Closing a panel leaves its
  terminal available; stopping or disconnecting its runner ends the terminal.
- **Git review:** refresh the actual repository status, inspect working or staged
  diffs, stage or unstage selected files, then commit the index with a message.
  Paths are passed as literal Git pathspecs. Untracked previews and command output
  are bounded. Git actions run on the project's computer, in its checkout.
- **Devices:** discover devices on the runner's computer, open an app in a separate
  agent-device session, refresh its screen, tap, type, go back/home and close the
  session. Keyboard users can submit tap coordinates. Android requires its SDK;
  iOS requires a Mac with Xcode. Screen coordinates use logical device dimensions.
  Panel session references are retained in a capped browser preference, and idle
  device sessions close after fifteen minutes.

Computer requests carry retry identities. Results are saved on the runner before
acknowledgement, so a lost response does not repeat a commit or worktree creation.
After an interrupted operation with no saved result, the UI asks the owner to
inspect the current state rather than replaying it automatically.

## Conversation reliability

Message sends and chat creation accept retry identities. A lost send response is
retried with the original identity and checked against its committed receipt.
File drafts stay with their chat; asynchronous failures restore the originating
draft. Draft files have bounded retention.

Remote runners fetch backend-local attachments through authenticated, assigned
runner URLs. Shared output files gain a stored backend copy. Model and usage
pickers follow the chat/project computer. Disconnecting a runner clears its local
session cursors. Fresh sessions retain opening requirements and recent history,
with explicit links to omitted pages; `read_chat` pages long messages, and
`read_chat_attachment` retrieves historical attachments in chunks.

Codex native questions and Claude's AskUserQuestion appear in chat and the Board.
Answers are recorded in portable history. Search retrieves a match per thread,
so one busy chat cannot hide another. Text previews request a bounded byte range,
stop reading at the preview limit and abort when closed.

## Verification

Use `pnpm codegen`, `pnpm typecheck` and `pnpm build`. The existing Board regression
runner is `pnpm exec bun artifacts/board-view/run.ts <temporary-output-directory>`.

The additional workflow verification uses production Next.js, SQLite, the real
authenticated runner channel, a real Windows PTY, disposable Git repositories and
Chromium. Engines are stand-ins, so verification does not consume model credits.
Repeat these owner journeys after changes:

1. Execute a terminal command in each of two projects and verify their files stay
   in separate folders. Reject a cross-chat terminal session ID.
2. Create a worktree, review a new file, stage/unstage it and commit. Retry the
   commit identity and verify there is exactly one new commit.
3. Switch chats with unsent attachments. Drop a send acknowledgement after commit
   and verify one turn, a cleared composer and no false delivery failure.
4. Download a backend-local attachment from its assigned runner; reject another
   runner. Page long history and retrieve an old attachment after a session reset.
5. Answer a native question through the UI and verify the runner, Board badge and
   portable history agree.
6. Sign in with a persistent test cookie, transfer Personal and verify the cookie
   remains. Promote an old chat profile and verify its sign-in in another chat.
7. Open the Terminal, Git review and Devices panels through their UI. Preview a
   large text file and verify it is capped. Disconnect a runner and verify its
   native cursor is cleared.

End runs with a JSON check report and screenshots, inspect them, then remove the
temporary harness, server homes, repositories, browser profiles and evidence.
Actual device interaction still needs a host with an Android SDK or Xcode; neither
was available on the Windows verification machine.

Verified on 24 November 2026: production build and typecheck passed, all 64 new
workflow checks passed, and all 76 existing Board regression checks passed. The
workflow run covered real PTY input through the UI, Git rename staging and initial
commits, profile cookie retention across close/transfer/legacy promotion, delayed
send failures across navigation, queued work across computer changes and portable
history. Desktop screenshots were inspected and no browser runtime errors were
reported. The Board regression also checked 390 px phone layouts.

One earlier failed run left the ignored disposable directory
`node_modules/.workspace-e2e-C3TgCv` after a Windows file lock prevented its cleanup.
Automatic approval review rejected a later removal attempt as "blocked by policy";
that directory was left in place. Other temporary workflow harnesses, homes and
evidence were removed after verification.
