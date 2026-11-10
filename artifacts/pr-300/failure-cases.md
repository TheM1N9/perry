# Stream review verification inventory

Before isolated integration harness code: use Node's real ReadableStream and the
actual streamBrowser module, with an in-memory fake CDP host (no browser, network,
real config, processes, credentials or filesystem sessions).

Failure modes: cancel while status/start is awaiting; abort before/after subscription;
last subscriber leaves but timers/CDP listeners remain; one subscriber leaving stops
another; duplicate starts from concurrent subscribers; stop/start overlap; failed start
never retries; old page frames get labelled with a new identity; delayed old listener
emits after stop; a stalled reader buffers unbounded frames/state; pending frames beat
the state they belong to; first frame is missing for a new subscriber; widths change
without restarting; repeated close throws. Finish with bounded JSON evidence.

File link review: Windows drive links are removed by react-markdown's default URL
transform before lookup. Verify the real Markdown renderer with registered fake
Windows paths, file URLs, relative links, unregistered paths and unsafe schemes.
No file contents need to be served or read for that rendering verification.
