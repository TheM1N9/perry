# Computer panel transport failure inventory

Before the browser fixture, enumerate the boundary conditions:

- Explicit rejected requests consume the 32-request uncertainty budget and eventually disable unrelated computer work.
- A committed request whose acknowledgement is lost is resent with a new operation ID and can execute twice.
- Two lost acknowledgements erase the operation ID, so the owner's manual retry cannot recover the same operation.
- An unavailable backend permits an unbounded pending-operation map rather than a useful bounded error.
- Unmount during result polling leaves a poll timer or continues querying after the panel is gone.
- Result errors leave the panel busy, overwrite a later operation, or prevent subsequent successful work.
- The fixture replaces React or the transport implementation, hiding production behavior. Use actual `useMachine`, providers, BackendClient and HTTP; replace only the loopback server's protocol responses. Native runner execution is covered separately by `run.mjs`.

## Production terminal chunks

- An actual Next-built xterm chunk fails to download, leaving Open terminal enabled without an initialized terminal or leaving no actionable retry.
- Restoring the chunk and clicking Try again reuses a rejected module promise forever, duplicates xterm DOM, or retains its ResizeObserver.
- Closing the terminal tab while the chunk is pending lets its late import create DOM/observers after unmount. Reopening after completion must initialize one working terminal.
- Closing a successfully initialized tab leaves an observer attached to its discarded terminal host.
- A browser exception or test failure skips native Next server/browser/home teardown or fails to save the report. Use a fresh home and real built Next application, intercept only the identified xterm chunk's HTTP response.
