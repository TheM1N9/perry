# Browser fixture failure inventory (before browser fixture code)

- Injection after actual React media access, accidental real bridge replacement, native microphone/screen fallback, insecure-origin mediaDevices absence, incomplete fake bridge methods/subscription cleanup.
- Pet needs a synthetic authenticated backend session; bridge fixture alone cannot fake its queries/mutations. Hotkey completion can auto-send and must only target coordinator's synthetic backend.
- Silence/voice switching while capture is active; analyser silence and decoded silence must agree; malformed samples; codec decoding accidentally invokes native code.
- Recorder stop/final data event ordering, duplicate stop, canceled late chunks, unexpected stop/error, fake recorder interval leaks and fake tracks/context left open.
- Capturing unrelated app timeouts by delay alone; globally shifting performance.now or Date.now breaks backend/UI scheduling; expired deadline fired twice or still active after manual stop.
- Extra fixture DOM before hydration causes mismatch; panel must mount after hydration or manually; panel event listeners must never call native pet/screen methods.
- Fixture status updates must not be mistaken for React renders; frequency read/DOM mutation counts alone cannot prove React render counts. Production/minified timeout callback matching may fail; expose capture count and fail clearly instead of modifying unrelated timers.
- Polling/mutation observer fixture cleanup; frozen fixtures vs native API properties; repeated injection without restoring global API definitions; beforeunload cleanup.

Only scratch script/docs will be prepared here. No browser/server/build/native media/API/model run. Coordinator must execute browser acceptance and record its actual artifact.
