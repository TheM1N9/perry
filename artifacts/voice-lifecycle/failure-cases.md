# Voice lifecycle failure inventory

Written before the browser fixture. Use the production hook with actual React, Web Audio and MediaRecorder, replacing only the permission boundary and the transcription bridge. No system microphone or paid model calls.

- Permission denial or no microphone leaves the pet listening, gives no recovery instruction, or retains a progress subscriber after unmount.
- Cancel or unmount while permission is pending lets a late stream become active or leaks its tracks.
- A rapid cancel/restart lets the first pending stream replace the second recording.
- Active recording cancellation leaves live audio tracks, contexts, recorder work or animation callbacks.
- A disconnected recording does not automatically settle, repeats completion, or submits stale text after cancellation.
- A failed transcription discards the recording, prevents retry, or leaks decoder contexts.
- A late transcription result after cancellation/unmount changes the new draft.
- A production dependency or fixture browser error makes a false positive. Every scenario checks externally visible hook state and native resource counts.
