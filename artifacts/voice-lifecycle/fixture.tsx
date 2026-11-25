import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useVoice, type VoiceBridge } from "../../components/pet/voice";

const NativeContext = window.AudioContext;
const contexts: AudioContext[] = [];
const streams: MediaStream[] = [];
const recorders: MediaRecorder[] = [];
let permission = "granted";
let transcription = "success";
let subscribed = 0;
let calls = 0;
let done = 0;
let pendingPermission: (() => void) | undefined;
let pendingTranscript: ((value: { text: string }) => void) | undefined;
window.AudioContext = class extends NativeContext {
  constructor(options?: AudioContextOptions) { super(options); contexts.push(this); }
};
const NativeRecorder = window.MediaRecorder;
window.MediaRecorder = class extends NativeRecorder {
  constructor(stream: MediaStream, options?: MediaRecorderOptions) { super(stream, options); recorders.push(this); }
};
function stream() {
  const context = new AudioContext();
  const source = context.createOscillator();
  const gain = context.createGain();
  gain.gain.value = 0.2;
  const destination = context.createMediaStreamDestination();
  source.connect(gain).connect(destination); source.start();
  void context.resume();
  const created = destination.stream;
  // The fixture owns the oscillator feeding its synthetic microphone.
  for (const track of created.getTracks()) {
    const stop = track.stop.bind(track);
    track.stop = () => { stop(); void context.close().catch(() => {}); };
  }
  streams.push(created);
  return created;
}
Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: async () => {
  if (permission === "denied") throw new DOMException("Synthetic refusal", "NotAllowedError");
  if (permission === "missing") throw new DOMException("Synthetic missing device", "NotFoundError");
  if (permission === "held") await new Promise<void>(resolve => { pendingPermission = resolve; });
  return stream();
} });
const bridge: VoiceBridge = {
  hotkey: async () => ({ hotkey: null, error: null }), setHotkey: async () => ({ hotkey: null, error: null }),
  onVoice: () => () => {},
  onVoiceProgress: () => { subscribed++; return () => { subscribed--; }; },
  voiceDone: () => { done++; },
  transcribe: async () => {
    calls++;
    if (transcription === "failed") return { error: "Synthetic unavailable model" };
    if (transcription === "held") return new Promise(resolve => { pendingTranscript = resolve; });
    return { text: "Synthetic words" };
  },
};
function Voice() {
  const voice = useVoice(bridge, promise => { void promise.then(text => { Object.assign(window, { automaticText: text }); }); });
  Object.assign(window, { voiceActions: voice });
  return <div><output id="state">{JSON.stringify({ state: voice.state, error: voice.error, failed: voice.failed })}</output><div ref={voice.waveform}>{Array.from({ length: 28 }, (_, key) => <span key={key} />)}</div></div>;
}
function Fixture() {
  const [mounted, setMounted] = useState(true);
  Object.assign(window, { mountVoice: setMounted });
  return mounted ? <Voice /> : <output id="unmounted">Unmounted</output>;
}
Object.assign(window, {
  configureVoice: (nextPermission: string, nextTranscription = "success") => { permission = nextPermission; transcription = nextTranscription; },
  releasePermission: () => { pendingPermission?.(); pendingPermission = undefined; },
  releaseTranscript: () => { pendingTranscript?.({ text: "Stale words" }); pendingTranscript = undefined; },
  disconnectRecorder: () => recorders.at(-1)?.stop(),
  voiceResources: () => ({
    tracks: streams.flatMap(stream => stream.getTracks()).filter(track => track.readyState === "live").length,
    contexts: contexts.filter(context => context.state !== "closed").length,
    recorders: recorders.filter(recorder => recorder.state !== "inactive").length,
    subscribed, calls, done,
  }),
});
createRoot(document.getElementById("root")!).render(<Fixture />);
