/* Perry #257: inject into a fresh disposable /pet page BEFORE React scripts.
 * No native media constructor or bridge method is ever invoked.
 * Backend isolation/authentication is the coordinator's separate responsibility.
 */
(() => {
  "use strict";
  if (window.__perryVoiceFixture) return;
  if (window.perryPet) throw new Error("Voice fixture requires a disposable browser without an existing pet bridge.");
  const native = {
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
  };
  const originals = {
    timeout: Object.getOwnPropertyDescriptor(window, "setTimeout"),
    clear: Object.getOwnPropertyDescriptor(window, "clearTimeout"),
  };
  const state = { mode: "silence", decodedSeconds: 1, holdTranscription: false, transcript: "Synthetic voice acceptance.", getUserMediaCalls: 0, recorderStarts: 0, recorderStops: 0, transcribeCalls: 0, voiceDoneCalls: 0, meterReads: 0, frequencyReads: 0, waveformMutations: 0 };
  const recorders = new Set(), contexts = new Set(), tracks = new Set(), deadlines = new Map(), listeners = new Map(), transcriptions = [], events = [];
  let panel, status, poll, observed, observer, disposed = false;
  const log = (type, detail = {}) => { events.push({ type, at: Math.round(performance.now()), ...detail }); if (events.length > 100) events.shift(); };
  const subscribe = (name, fn, initial) => { let set = listeners.get(name); if (!set) listeners.set(name, set = new Set()); set.add(fn); if (initial !== undefined) queueMicrotask(() => { if (set.has(fn)) fn(initial); }); return () => set.delete(fn); };
  const emit = (name, value) => { for (const fn of [...(listeners.get(name) || [])]) fn(value); };
  const emitVoice = (type) => { if (!["start", "stop", "cancel"].includes(type)) throw Error("Invalid fake voice event"); log("voice-event", { type }); emit("voice", type); };
  function snapshot() {
    return { ...state, liveTracks: [...tracks].filter(t => t.readyState === "live").length, openContexts: [...contexts].filter(c => c.state !== "closed").length, recordingCount: [...recorders].filter(r => r.state === "recording").length, recorderIntervals: [...recorders].filter(r => r._timer !== null).length, capturedDeadlines: deadlines.size, deferredTranscriptions: transcriptions.length, voiceSubscribers: listeners.get("voice")?.size || 0, transcriptionSampleLengths: events.filter(e => e.type === "transcribe").map(e => e.samples), events: events.slice() };
  }
  function createStream() {
    const track = { kind: "audio", id: "synthetic-track-" + (tracks.size + 1), label: "Synthetic voice fixture", enabled: true, muted: false, readyState: "live", stop() { if (this.readyState !== "ended") { this.readyState = "ended"; log("track-stop"); } }, getSettings() { return { sampleRate: 48000, channelCount: 1 }; } };
    tracks.add(track);
    return { id: track.id, active: true, getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
  }
  class FakeAudioContext {
    constructor(options) { if (disposed) throw Error("Synthetic fixture disposed; native audio remains blocked"); this.sampleRate = options?.sampleRate || 48000; this.state = "running"; contexts.add(this); log("context-create", { sampleRate: this.sampleRate }); }
    async resume() { if (this.state === "closed") throw Error("Synthetic context closed"); this.state = "running"; }
    async close() { if (this.state !== "closed") { this.state = "closed"; log("context-close"); } }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() {
      const context = this;
      return {
        fftSize: 2048, get frequencyBinCount() { return this.fftSize / 2; },
        getFloatTimeDomainData(data) { if (context.state === "closed") throw Error("Meter read after synthetic context close"); state.meterReads++; for (let i = 0; i < data.length; i++) data[i] = state.mode === "voice" ? .08 * Math.sin(i * .13) : 0; },
        getByteFrequencyData(data) { if (context.state === "closed") throw Error("Frequency read after synthetic context close"); state.frequencyReads++; const phase = performance.now() / 180; for (let i = 0; i < data.length; i++) data[i] = state.mode === "voice" ? Math.floor(15 + 220 * (1 + Math.sin(i * .023 + phase)) / 2) : 0; },
      };
    }
    async decodeAudioData() {
      // Fixed short synthetic PCM unless acceptance explicitly requests a longer buffer.
      const length = Math.round(Math.max(0, Math.min(301, state.decodedSeconds)) * this.sampleRate);
      const data = new Float32Array(length);
      if (state.mode === "voice") for (let i = 0; i < length; i++) data[i] = .08 * Math.sin(i * .17);
      log("decode", { samples: length });
      return { length, duration: length / this.sampleRate, numberOfChannels: 1, sampleRate: this.sampleRate, getChannelData: () => data };
    }
  }
  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported() { return true; }
    constructor(stream) { super(); if (disposed) throw Error("Synthetic fixture disposed; native recorder remains blocked"); this.stream = stream; this.state = "inactive"; this.mimeType = "audio/synthetic"; this._timer = null; recorders.add(this); }
    start(timeslice = 250) { if (this.state !== "inactive") throw new DOMException("Already recording", "InvalidStateError"); this.state = "recording"; state.recorderStarts++; this._timer = native.setInterval(() => this._data(), timeslice); log("recorder-start"); }
    _data() { const event = new Event("dataavailable"); Object.defineProperty(event, "data", { value: new Blob(["synthetic recording bytes"], { type: this.mimeType }) }); this.ondataavailable?.(event); this.dispatchEvent(event); }
    stop() { if (this.state === "inactive") throw new DOMException("Not recording", "InvalidStateError"); this.state = "inactive"; state.recorderStops++; if (this._timer !== null) native.clearInterval(this._timer); this._timer = null; log("recorder-stop"); queueMicrotask(() => { this._data(); const event = new Event("stop"); this.onstop?.(event); this.dispatchEvent(event); }); }
    requestData() { this._data(); }
  }
  const media = {
    async getUserMedia(constraints) { if (disposed) throw Error("Synthetic fixture disposed; microphone remains blocked"); if (!constraints?.audio || constraints.video) throw Error("Only synthetic audio is supported"); state.getUserMediaCalls++; log("get-user-media"); return createStream(); },
    async getDisplayMedia() { throw Error("Screen capture blocked by synthetic fixture"); },
    async enumerateDevices() { return [{ kind: "audioinput", deviceId: "synthetic", groupId: "synthetic", label: "Synthetic fixture input" }]; },
    addEventListener() {}, removeEventListener() {},
  };
  const hotkey = (value = "Control+Shift+Space") => ({ hotkey: value, error: null, hold: "Synthetic fixture uses tap events only." });
  const bridge = {
    solid() {}, moveTo() {}, dragStart() {}, dragEnd() {},
    onArmed: (fn) => subscribe("armed", fn, false),
    onPlace: (fn) => subscribe("place", fn, { x: 0, y: 0, below: false }),
    idleSeconds: async () => 0,
    openDashboard: (path) => log("dashboard-open-blocked", { path }),
    hotkey: async () => hotkey(), setHotkey: async (value) => hotkey(value),
    onVoice: (fn) => subscribe("voice", fn), onVoiceProgress: (fn) => subscribe("progress", fn),
    async transcribe(samples) { if (disposed) throw Error("Synthetic fixture disposed"); state.transcribeCalls++; log("transcribe", { samples: samples.length }); if (!(samples instanceof Float32Array) || !samples.length) throw Error("Expected synthetic PCM samples"); if (state.holdTranscription) return new Promise(resolve => transcriptions.push(resolve)); return { text: state.transcript }; },
    voiceDone() { state.voiceDoneCalls++; log("voice-done"); },
    look: async () => ({ error: "Screen capture is blocked by the synthetic voice fixture." }),
    onLook: (fn) => subscribe("look", fn), setLookHotkey: async (value) => hotkey(value),
  };
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
  for (const [name, value] of [["AudioContext", FakeAudioContext], ["webkitAudioContext", FakeAudioContext], ["MediaRecorder", FakeMediaRecorder], ["perryPet", bridge]]) Object.defineProperty(window, name, { configurable: true, writable: true, value });
  // Intercept ONLY the voice's literal five-minute deadline while a fake recorder
  // is active. App time, performance.now, RAF, intervals and other timeouts stay native.
  window.setTimeout = function(callback, delay, ...args) {
    const isVoiceDeadline = Number(delay) === 300000 && typeof callback === "function" && String(callback).includes("five-minute") && [...recorders].some(r => r.state === "recording");
    if (!isVoiceDeadline) return native.setTimeout(callback, delay, ...args);
    let id;
    const run = () => { if (!deadlines.has(id)) return; deadlines.delete(id); log("deadline-fired"); callback(...args); };
    id = native.setTimeout(run, delay);
    deadlines.set(id, { run, remaining: Number(delay) });
    log("deadline-captured");
    return id;
  };
  window.clearTimeout = function(id) { deadlines.delete(id); return native.clearTimeout(id); };
  function advanceCapture(ms = 300000) {
    if (!deadlines.size) throw Error("No voice deadline captured. Start UI Talk and verify capture count first.");
    for (const [id, deadline] of [...deadlines]) { deadline.remaining -= ms; if (deadline.remaining <= 0) { native.clearTimeout(id); deadline.run(); } }
    log("capture-advanced", { ms });
    refresh();
  }
  function setMode(mode) { if (!["silence", "voice"].includes(mode)) throw Error("Expected silence or voice"); state.mode = mode; log("mode", { mode }); refresh(); }
  function refresh() {
    if (status) { const data = snapshot(); delete data.events; status.textContent = JSON.stringify(data, null, 2); }
    const target = document.querySelector('[role="status"][aria-label="Listening"] [aria-hidden]');
    if (target !== observed) { observer?.disconnect(); observed = target; if (target) { observer = new MutationObserver(records => { state.waveformMutations += records.length; }); observer.observe(target, { subtree: true, attributes: true, attributeFilter: ["style"] }); } }
  }
  function mount() {
    if (panel || disposed || !document.body) return;
    panel = document.createElement("aside"); panel.id = "perry-voice-fixture";
    panel.style.cssText = "position:fixed;left:12px;top:12px;width:310px;max-height:calc(100vh - 24px);overflow:auto;z-index:2147483647";
    const shadow = panel.attachShadow({ mode: "open" });
    const style = document.createElement("style"); style.textContent = ":host{font:12px system-ui;color:#17221b}section{background:#f4f9f5;border:1px solid #769a80;border-radius:8px;padding:12px}h2{font-size:14px;margin:0 0 6px}p{margin:6px 0}button{margin:3px;padding:6px;cursor:pointer}pre{font:11px monospace;white-space:pre-wrap}strong{color:#154f28}"; shadow.append(style);
    const section = document.createElement("section"); section.setAttribute("aria-label", "Synthetic voice acceptance controls");
    const heading = document.createElement("h2"); heading.textContent = "Synthetic voice fixture"; section.append(heading);
    const safety = document.createElement("p"); safety.textContent = "Fake mic, recorder, audio and bridge. Backend must also be synthetic."; section.append(safety);
    const button = (label, action) => { const element = document.createElement("button"); element.type = "button"; element.textContent = label; element.addEventListener("click", action); section.append(element); };
    button("Silence", () => setMode("silence")); button("Valid audio", () => setMode("voice"));
    button("Open chat (start/cancel)", () => { emitVoice("start"); native.setTimeout(() => emitVoice("cancel"), 150); });
    button("UI Talk (draft)", () => { const element = document.querySelector('button[aria-label="Talk"]'); if (!element) throw Error("Open chat first, then use UI Talk"); element.click(); });
    button("Expire 5m capture", () => advanceCapture());
    button("Cancel", () => emitVoice("cancel"));
    button("Toggle hold transcript", () => { state.holdTranscription = !state.holdTranscription; refresh(); });
    button("Resolve held transcript", () => fixture.resolveTranscriptions());
    const hint = document.createElement("p"); hint.textContent = "Use Perry's actual Send/Stop controls. Five-minute expiry advances only its captured voice deadline. State below is fixture instrumentation, not a React render counter."; section.append(hint);
    status = document.createElement("pre"); status.setAttribute("aria-label", "Synthetic media resource counts"); section.append(status); shadow.append(section); document.body.append(panel);
    poll = native.setInterval(refresh, 200); refresh();
  }
  function dispose() {
    if (disposed) return;
    // Stop React's active voice session before restoring globals; pending decode
    // completions retain their fake instances and never fall back to native audio.
    emitVoice("cancel"); disposed = true;
    for (const recorder of recorders) if (recorder.state !== "inactive") recorder.stop();
    for (const track of tracks) track.stop(); for (const context of contexts) void context.close();
    for (const id of deadlines.keys()) native.clearTimeout(id); deadlines.clear();
    if (poll) native.clearInterval(poll); observer?.disconnect(); panel?.remove();
    const restore = (object, key, descriptor) => { if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key]; };
    // Keep media/bridge fakes installed in a disposed/denied state. Restoring
    // native media while React stays mounted could allow a later UI Talk to
    // touch the microphone. Closing this disposable page is the final cleanup.
    for (const [key, descriptor] of [["setTimeout", originals.timeout], ["clearTimeout", originals.clear]]) restore(window, key, descriptor);
    for (const resolve of transcriptions.splice(0)) resolve({ text: "" });
    log("disposed");
  }
  const fixture = { state, snapshot, setMode, emitVoice, advanceCapture, mount, dispose, resolveTranscriptions(text = state.transcript) { for (const resolve of transcriptions.splice(0)) resolve({ text }); }, progress(value) { emit("progress", value); } };
  Object.defineProperty(window, "__perryVoiceFixture", { configurable: true, value: fixture });
  // Deferring panel DOM helps avoid interfering with document hydration. If the
  // coordinator knows hydration is complete it can call fixture.mount() sooner.
  const deferredMount = () => native.setTimeout(mount, 1000);
  if (document.readyState === "complete") deferredMount(); else window.addEventListener("load", deferredMount, { once: true });
  window.addEventListener("pagehide", dispose, { once: true });
  log("installed");
})();
