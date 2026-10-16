# PR299 follow-up failure inventory, before extending acceptance

- An active history subscription can fail with a transient non-BackendError and remain unloaded with no in-flight request; a hover must release its temporary listener/gate so later chats can still prefetch.
- An unfinished inline code span nested in unfinished emphasis can leave raw emphasis delimiters; installed Markdown SSR must produce nested emphasis/code, while static output remains native.
- Pending metadata can unmount a focused composer during first send or navigation. Keep draft/textarea mounted; prevent button/Enter/command submission until fresh owner metadata is present. Contact chats must still become read only.
- The fake voice observer can target a hidden icon instead of the actual waveform div; use real React DOM and verify positive style mutation counts under synthetic audio, then zero live resources on cancellation.
- Invalid backend JSON can reject the fixture HTTP handler and terminate it; forward original malformed input to the real backend validation and verify a 400 response followed by a successful request.
- Reuse the existing isolated fixture, dependencies and .next only. No dotenv/real data, services, engine, mic or browser profile; keep fresh home on W: and stop via own execution session.
