# Isolated voice E2E failure inventory (before harness code)

Use only synthetic AudioContexts, streams, MediaRecorder events, timers, DOM bars and bridge. No project bootstrap or backend imports. Block fetch/network. No microphone or model calls.

- Silence, DC/muted input, below-floor room noise, transient impulse, short taps and valid speech; exact threshold, mono/stereo downmix and nonfinite samples.
- Meter scheduling gaps/background animation pause; frequency bands differ and scaleY updates produce no React state updates.
- Permission rejection; cancellation/unmount while permission pending; rapid cancel/start; partial constructor/source/resume/start failure; muted/ended tracks.
- Duplicate start/stop, stop during opening, cancel before stop event, cancel during decode/transcribe, unmount in every pending stage, stale completion after a new session.
- Recorder error or spontaneous stop, final data before stop, empty chunks, throwing stop, decode rejection, bridge rejection/error/empty text.
- Maximum duration triggers exactly one stop and consumer completion, resets hotkey immediately, no later timer/animation/track/context leak; manually stopping first clears deadline; decoded samples bounded.
- Every teardown is idempotent; tracks, timers, animation frames and contexts close; decoder closes on rejection; no state update/transcription/result after cancellation/unmount.
- Model progress subscription unsubscribe; progress from obsolete work does not overwrite a newer session. Consumer draft versus auto-send behavior preserved by focused integration proposal.

Browser layout, real React profiler, actual Electron/media codec behavior and real microphone quality remain coordinator acceptance work. Fake lifecycle E2E verifies the hook through an isolated React dispatcher, not helper unit tests.
