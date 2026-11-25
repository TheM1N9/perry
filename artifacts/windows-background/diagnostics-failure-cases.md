# Background API diagnostics

Failure inventory recorded before implementation and isolated verification.

- Background dashboard errors disappear after the first generic stderr warning.
- Runner output or dashboard stdout exposes private titles, arguments, approvals or credentials.
- Exception messages, stacks, prefixes, suffixes, unknown classes or malformed operation names escape the exact sanitized-line allowlist.
- A valid diagnostic split across chunks is lost or duplicated; multiple diagnostics in one chunk are merged.
- LF, CRLF, or an unterminated final diagnostic behaves differently.
- A long private line grows memory without limit, or its diagnostic-looking suffix becomes a new trusted line after truncation.
- Stream error, early close, child restart or normal EOF retains buffered private bytes/listeners or joins output from different child lifetimes.
- Foreground debugging stops showing the existing detailed output.

Verification must use native child-process stderr pipes, split and oversized output, and explicit close/error teardown. No provider, model, installed service, account or owner database is needed.

## Verification, 26 November 2026

The temporary native-process fixture passed 15 checks. It copied the actual supervisor and its local imports into a fresh checkout, supplied fake runner and dashboard executables, and ran `perry run --background`. The dashboard emitted a diagnostic across three chunks and a split CRLF, multiple lines together, invalid prefixes/suffixes/classes, and a 1 MiB private line with a diagnostic-looking suffix. It then exited and restarted with the previous partial line's suffix. Only complete allowed diagnostics appeared; no private marker or malformed line appeared. Foreground output still included both detailed streams.

Additional native child stderr pipes verified an unterminated final diagnostic, normal EOF, early stream close, stream error, and repeated explicit mid-flight teardown. Forwarding listeners were removed; an unrelated native close listener was preserved. The buffer is fixed at 256 bytes and never retains an oversized input chunk.

The fixture stopped its isolated supervisor through the existing SIGTERM handler using a preload stdin bridge: Windows `child.kill("SIGTERM")` force termination did not exercise graceful shutdown. Normal handler shutdown released the isolated lock. The temporary checkout/home was removed after each run. The disposable driver and generated result were removed after verification, as required by project rules. No installed service was started, stopped or modified.

`pnpm exec tsc --noEmit` passed. This verifies safe diagnostic forwarding, not the cause of the owner's intermittent backend error.
