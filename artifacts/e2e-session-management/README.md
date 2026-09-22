# Session management E2E record

Run on 2026-09-23 against the configured Convex deployment and the production Next.js build. No model request was sent during verification.

## Repeat

1. Run `pnpm run build` and `pnpm run start -- -p 3107`.
2. Open `http://localhost:3107`, enter the configured dashboard key, and open **Activity**.
3. Filter Status to **Errors**; all visible runs must have `error` status. Select the Telegram session; the combined filter must show the empty state. Clear the filters.
4. Click **Open chat** on a web run. The Chat sidebar and header must show the same session ID as Activity.
5. Search chats for text in an existing message and open the matching result.
6. Branch from a message. Confirm the branch has a new session ID, shows its parent, and contains the selected history. Rename it, then click **New chat** and verify the blank composer does not create another session until a message is sent. Delete the temporary branch and confirm the original remains.
7. Resize to 390 × 844. Check the new chat view, mobile navigation, and Activity layout.

## Observed

- `pnpm run typecheck` and `pnpm run build` passed.
- Activity showed 13 runs across 2 sessions; filtering to errors showed 3 error runs, and combining that with the Telegram session showed no matching runs.
- **Open chat** selected web session ending `3s8ex7by`, matching the Activity record.
- Search for `pong` found the Dashboard chat and its message snippet.
- Branching created session ending `w18ew82b` with a parent link and the selected message. Rename succeeded. The blank **New chat** view left the conversation count at 2. Deleting the temporary branch returned the Chat count to 1.
- Desktop and 390 px mobile layouts were visually inspected.

## Evidence

- [Browser recording](session-flow.mp4)
- [Activity desktop](activity-desktop.png)
- [Chat desktop](chat-desktop.png)
- [Chat mobile](chat-mobile.png)
- [Activity mobile](activity-mobile.png)

The run used existing messages for search and branching. Results involving counts will vary with the deployment's data; the relationships and behaviors above are the repeatable assertions.
