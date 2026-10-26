# Full-access permission regression inventory

Recorded before extending the approval E2E or editing permission routing.
Use the installed Codex 0.163.0 app-server generated protocol as the contract.
Use its real adapter, the extracted production runner dispatcher, actual approval
mutations and disposable SQLite. No native agent, account or model is started.

- Full-access native network/filesystem permission requests fall through to a
  silent decline, leaving the assistant asking the owner to grant access again.
- Ask/Auto grants are silently refused instead of offering the actual request.
- A pending computer permission does not resolve after switching the chat to Full.
- A broad permission is mistaken for a saved file/command rule or Always allow.
- Decline omits the required native `scope`, or grants more than the requested
  permissions; session-wide approval prevents a later access downgrade.
- A replaced, missing, quick/reviewer or interrupted native turn receives a grant.
- A stale request's turn ID selects a newer turn's Full access.
- A request approved just as Stop interrupts the engine still receives a grant.
- Full access in one chat changes another chat's approval policy.
- Generic external tool consent, forms and authentication challenges are confused
  with native computer permissions; existing explicit-confirmation flows regress.
- Existing command/file auto approval, declines and browser Full access regress.

The user's exact prompt has not been recovered. These checks establish the native
computer-permission fault, rather than asserting it was the only observed cause.
