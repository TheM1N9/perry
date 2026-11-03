# Meeting capture in CI

`pnpm exec node --experimental-transform-types --import ./artifacts/security-audit-20261028/loader.mjs artifacts/meetings/run.mjs <output-directory>`

Requires the root and `pet/` dependencies. No accounts or paid model calls are used. The harness creates its own SQLite database, owner key, native speech fixtures, Electron profile, and backend on an ephemeral loopback port. It deletes its scratch directory and keeps `result.json`, the Electron report, and process logs in the requested output directory.

The Windows job installs Scream 4.0 on the disposable GitHub-hosted VM to supply a real WASAPI rendering endpoint. A test preload supplies only `getUserMedia` with a synthetic microphone stream from Web Audio. A different recording plays through the Windows output device. Whisper must transcribe both independently through the production capture window, worklet, utility process and backend. `getDisplayMedia`, loopback capture, chunking, IPC and transcription are unchanged. Chromium's global fake-device flags are deliberately avoided because they also replace loopback input.

The macOS job runs the same Electron pipeline. A system-audio permission refusal must be reported clearly while microphone transcription continues. This is recorded as `permission-blocked`, not successful loopback coverage. A live system-audio track that transcribes nothing fails the job. Passing a hosted job cannot establish physical microphone quality, echo cancellation, or macOS permission behavior on every user's machine.

## Failure inventory, before implementing the checks

- Electron does not boot, cannot load the sandboxed preload/worklet, or exits without a report.
- The fake microphone fixture is not captured, source clocks are wrong, no chunks reach the worker, silence is hallucinated, or ONNX cannot load in the real utility process.
- The system track is unavailable, dies after the video track is stopped, captures silence, or contains the microphone phrase instead of the independently played output phrase.
- macOS denial hangs or silently claims successful loopback; partial capture is not reported.
- Recreating the pet's UI destroys its independent capture window.
- Server delivery fails once and loses or duplicates segments; Stop drops the last phrase or finishes before the queue is drained.
- Write-up claims can be taken twice, stale results overwrite notes, typed notes disappear, generated lines lose outside-content provenance, or an action item creates duplicate to-dos.
- Stop/dispose leaves a worker, window, IPC listener, timer or database behind. A timeout leaves child processes running or suppresses failure artifacts.
- CI accidentally uses the owner's home, credentials or installed pet; audio-driver setup runs on a persistent machine; a downloaded driver archive differs from the pinned checksum.

CI uploads reports even after failure and writes coverage to the job summary. Generated audio, databases and profiles are not committed or uploaded. The source harness is permanent CI coverage requested for this feature.
