"use client";

import { MicIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress";
import { PetTip } from "./tip";

/**
 * Talking to Perry: the microphone, recorded here in the page while he
 * listens, and turned into text by his window (pet/voice.js), on this
 * computer. What you say goes into his chat.
 */

type Transcribed = { text?: string; error?: string };
/**
 * The Talk hotkey's keys, why not the ones asked for, and why only tapping
 * them works where holding does not (convex/lib/shortcuts.ts, holdProblem).
 * A pet window from before holding was reported says nothing of it.
 */
export type HotkeyState = { hotkey: string | null; error: string | null; hold?: string | null };
type Progress = { file: string; loaded: number; total: number };

/** What the pet's window adds for talking (pet/preload.cjs). Absent in a plain browser. */
export type VoiceBridge = {
  /** The Talk hotkey's keys, and why not the ones asked for ("taken" by another app). */
  hotkey: () => Promise<HotkeyState>;
  setHotkey: (accelerator: string) => Promise<HotkeyState>;
  onVoice: (listener: (type: "start" | "stop" | "cancel") => void) => () => void;
  onVoiceProgress: (listener: (progress: Progress) => void) => () => void;
  transcribe: (samples: Float32Array) => Promise<Transcribed>;
  voiceDone: () => void;
};

export type VoiceState = "idle" | "listening" | "transcribing";
export type Voice = {
  state: VoiceState;
  /** The analyser draws into these bars without updating React state. */
  waveform: RefObject<HTMLDivElement | null>;
  /** How far the voice model's first download has got, 0 to 1, while it downloads. */
  downloading: number | null;
  error: string;
  /** Start listening; whether he is, once the microphone is open. */
  start: () => Promise<boolean>;
  /** Stop listening and return what was said ("" for nothing), once the microphone is open if it is still opening. */
  stop: () => Promise<string>;
  cancel: () => void;
};

const BARS = 28;
const SAMPLE_RATE = 16_000;
const MAX_RECORDING_MS = 5 * 60_000;
// RMS amplitude (-46 dBFS): reject muted/quiet input before invoking the model.
const SPEECH_FLOOR = 0.005;
/** Ignore DC offset as well as silence. Native audio samples are normalized to -1..1. */
function rms(samples: Float32Array, offset = 0, end = samples.length) {
  let sum = 0;
  let squares = 0;
  for (let index = offset; index < end; index++) {
    const value = samples[index];
    if (!Number.isFinite(value)) return 0;
    sum += value;
    squares += value ** 2;
  }
  const length = end - offset;
  return Math.sqrt(Math.max(0, squares / length - (sum / length) ** 2));
}
/** One time of listening: the microphone, what it recorded, and the waveform's meter. */
type Live = {
  stream: MediaStream; recorder: MediaRecorder; chunks: Blob[]; context: AudioContext;
  timer: number; deadline: number; frame: number; peak: number; cancelled: boolean;
  closed: boolean; stopped: Promise<void>; done: () => void; failure?: string; decoder?: AudioContext;
};
type Opening = { promise: Promise<boolean>; cancelled: boolean; release?: () => void };

function closeDecoder(current: Live) {
  const decoder = current.decoder;
  current.decoder = undefined;
  if (decoder) void decoder.close().catch(() => {});
}

/** Automatic stops use the same consumer path as Send, including its draft/hotkey policy. */
export function useVoice(bridge: VoiceBridge | undefined, onAutoStop?: (text: Promise<string>) => void): Voice {
  const [state, setState] = useState<VoiceState>("idle");
  const waveform = useRef<HTMLDivElement | null>(null);
  const [downloading, setDownloading] = useState<number | null>(null);
  const [error, setError] = useState("");
  const live = useRef<Live | null>(null);
  /**
   * The microphone while it opens, which can take a second (a Bluetooth
   * headset changing over): a stop that comes meanwhile waits for it, and a
   * cancel closes it as soon as it is open.
   */
  const opening = useRef<Opening | null>(null);
  const mounted = useRef(true);
  /** What is being written down: the last thing said can be, while he already listens to the next. */
  const writing = useRef(new Set<Live>());
  const settle = useCallback(() => {
    if (mounted.current) setState(live.current ? "listening" : writing.current.size ? "transcribing" : "idle");
  }, []);

  // The first time, the model downloads (a few files); its progress is all of them together.
  useEffect(() => {
    if (!bridge) return;
    const files = new Map<string, Progress>();
    return bridge.onVoiceProgress((progress) => {
      if (!mounted.current || !writing.current.size) return;
      files.set(progress.file, progress);
      const all = [...files.values()];
      const share = all.reduce((sum, file) => sum + file.loaded, 0) / Math.max(1, all.reduce((sum, file) => sum + file.total, 0));
      setDownloading(share >= 1 ? null : share);
    });
  }, [bridge]);

  const close = useCallback((current: Live) => {
    if (current.closed) return;
    current.closed = true;
    window.clearInterval(current.timer);
    window.clearTimeout(current.deadline);
    window.cancelAnimationFrame(current.frame);
    for (const track of current.stream.getTracks()) track.stop();
    void current.context.close().catch(() => {});
    if (waveform.current && !live.current) {
      for (const bar of waveform.current.children) (bar as HTMLElement).style.transform = "scaleY(0.08)";
    }
  }, []);

  const stop = useCallback(async (): Promise<string> => {
    // Capture this opening request: a later start must not be stopped by an old key release.
    const pending = opening.current;
    if (pending) {
      await pending.promise;
      if (pending.cancelled) return "";
    }
    const current = live.current;
    if (!current) return "";
    live.current = null;
    writing.current.add(current);
    settle();
    const wanted = () => mounted.current && !current.cancelled;
    try {
      if (current.recorder.state !== "inactive") current.recorder.stop();
      // Release hardware immediately; the recorder still dispatches its final data and stop events.
      close(current);
      await current.stopped;
      if (!wanted()) return "";
      if (current.failure) throw new Error(current.failure);
      if (current.peak < SPEECH_FLOOR) {
        setError("We didn't hear anything. Check that your microphone is on and try again.");
        return "";
      }
      if (!bridge || !current.chunks.length) return "";
      current.decoder = new AudioContext({ sampleRate: SAMPLE_RATE });
      const audio = await current.decoder.decodeAudioData(await new Blob(current.chunks, { type: current.recorder.mimeType }).arrayBuffer());
      closeDecoder(current);
      if (!wanted()) return "";
      const length = Math.min(audio.length, SAMPLE_RATE * MAX_RECORDING_MS / 1000);
      const samples = new Float32Array(length);
      for (let channel = 0; channel < audio.numberOfChannels; channel++) {
        const data = audio.getChannelData(channel);
        for (let index = 0; index < length; index++) samples[index] += data[index] / audio.numberOfChannels;
      }
      if (samples.length < SAMPLE_RATE / 3) return "";
      // Also check decoded audio: a stale meter reading or a muted track must not reach Whisper.
      let peak = 0;
      for (let offset = 0; offset < samples.length; offset += 320) {
        const end = Math.min(offset + 320, samples.length);
        for (let index = offset; index < end; index++) {
          if (!Number.isFinite(samples[index])) throw new Error("Invalid microphone audio.");
        }
        peak = Math.max(peak, rms(samples, offset, end));
      }
      if (peak < SPEECH_FLOOR) {
        setError("We didn't hear anything. Check that your microphone is on and try again.");
        return "";
      }
      const result = await bridge.transcribe(samples);
      if (!wanted()) return "";
      if (result.error) setError(`He couldn't make that out: ${result.error}`);
      else if (!result.text) setError("He didn't catch any words that time.");
      return result.error ? "" : result.text ?? "";
    } catch (cause) {
      if (wanted()) setError(`He couldn't make that out: ${cause instanceof Error ? cause.message : String(cause)}`);
      return "";
    } finally {
      close(current);
      closeDecoder(current);
      writing.current.delete(current);
      if (mounted.current) {
        if (!writing.current.size) setDownloading(null);
        settle();
      }
    }
  }, [bridge, close, settle]);

  const autoStop = useEffectEvent((current: Live, message: string) => {
    if (live.current !== current || current.cancelled || !mounted.current) return;
    setError(message);
    bridge?.voiceDone();
    const result = stop();
    onAutoStop?.(result);
  });

  const start = useCallback((): Promise<boolean> => {
    if (!mounted.current) return Promise.resolve(false);
    if (live.current) return Promise.resolve(true);
    if (opening.current) return opening.current.promise;
    setError("");
    const request: Opening = { promise: Promise.resolve(false), cancelled: false };
    opening.current = request;
    const open = (async () => {
      let stream: MediaStream | undefined;
      let context: AudioContext | undefined;
      let recorder: MediaRecorder | undefined;
      let active: Live | undefined;
      const releaseOpening = () => {
        if (stream) for (const track of stream.getTracks()) track.stop();
        if (context) void context.close().catch(() => {});
        stream = undefined;
        context = undefined;
      };
      request.release = releaseOpening;
      try {
        // As OpenWhispr does: the browser's echo and noise filters blur words, and Whisper copes with a room better than they do.
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        if (request.cancelled || !mounted.current) {
          releaseOpening();
          return false;
        }
        context = new AudioContext();
        if (context.state === "suspended") await context.resume();
        if (request.cancelled || !mounted.current) {
          releaseOpening();
          return false;
        }
        recorder = new MediaRecorder(stream);
        const chunks: Blob[] = [];
        const started = performance.now();
        recorder.ondataavailable = (event) => {
          if (event.data.size && !current.cancelled) chunks.push(event.data);
          // Media events can still arrive when background animation/timers are throttled.
          if (performance.now() - started >= MAX_RECORDING_MS) autoStop(current, "Recording stopped at the five-minute limit.");
        };
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        context.createMediaStreamSource(stream).connect(analyser);
        const wave = new Float32Array(analyser.fftSize);
        const frequencies = new Uint8Array(analyser.frequencyBinCount);
        let done = () => {};
        const stopped = new Promise<void>((resolve) => { done = resolve; recorder!.onstop = () => {
          resolve();
          autoStop(current, "The microphone stopped. Check its connection before recording again.");
        }; });
        const current: Live = { stream, recorder, chunks, context, stopped, done, timer: 0, deadline: 0, frame: 0, peak: 0, cancelled: false, closed: false };
        active = current;
        request.release = undefined;
        const meter = () => {
          if (current.closed) return;
          analyser.getFloatTimeDomainData(wave);
          current.peak = Math.max(current.peak, rms(wave));
        };
        const draw = () => {
          if (current.closed) return;
          analyser.getByteFrequencyData(frequencies);
          if (waveform.current) {
            for (let index = 0; index < BARS; index++) {
              // Logarithmic bands from 70 Hz to 5 kHz, clamped to the native FFT bins.
              const low = Math.min(frequencies.length - 1, Math.floor(70 * (5000 / 70) ** (index / BARS) * analyser.fftSize / context!.sampleRate));
              const high = Math.min(frequencies.length, Math.max(low + 1, Math.ceil(70 * (5000 / 70) ** ((index + 1) / BARS) * analyser.fftSize / context!.sampleRate)));
              let sum = 0;
              for (let bin = low; bin < high; bin++) sum += frequencies[bin];
              const bar = waveform.current.children[index] as HTMLElement | undefined;
              if (bar) bar.style.transform = `scaleY(${Math.max(0.08, sum / (high - low) / 255)})`;
            }
          }
          current.frame = window.requestAnimationFrame(draw);
        };
        recorder.onerror = () => {
          current.failure = "The microphone couldn't finish recording.";
          autoStop(current, current.failure);
        };
        recorder.start(250);
        live.current = current;
        meter();
        current.timer = window.setInterval(meter, 80);
        current.frame = window.requestAnimationFrame(draw);
        current.deadline = window.setTimeout(() => autoStop(current, "Recording stopped at the five-minute limit."), MAX_RECORDING_MS);
        return true;
      } catch (cause) {
        if (active) {
          active.cancelled = true;
          if (live.current === active) live.current = null;
          close(active);
        }
        try { if (recorder && recorder.state !== "inactive") recorder.stop(); } catch { /* Hardware is released below. */ }
        if (!active) {
          releaseOpening();
        }
        if (!request.cancelled && mounted.current) setError(cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "He can't hear you: allow the microphone for Perry in your system's privacy settings."
          : `He can't hear you: ${cause instanceof Error ? cause.message : String(cause)}`);
        return false;
      }
    })();
    request.promise = open;
    void open.then(() => {
      if (opening.current === request) opening.current = null;
      settle();
    });
    return open;
  }, [close, settle]);

  const cancel = useCallback(() => {
    if (opening.current) {
      opening.current.cancelled = true;
      opening.current.release?.();
    }
    opening.current = null;
    const current = live.current;
    live.current = null;
    for (const pending of writing.current) {
      pending.cancelled = true;
      pending.done();
      closeDecoder(pending);
    }
    writing.current.clear();
    if (current) {
      current.cancelled = true;
      try { if (current.recorder.state !== "inactive") current.recorder.stop(); }
      catch { /* Cancelling still releases hardware if the recorder already failed. */ }
      finally { close(current); }
    }
    if (mounted.current) setDownloading(null);
    settle();
  }, [close, settle]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel(); };
  }, [cancel]);
  return { state, waveform, downloading, error, start, stop, cancel };
}

/** Where the composer was, while he listens: the waveform, and how to send or stop. */
export function Listening({ voice, onSend, onCancel }: { voice: Voice; onSend: () => void; onCancel: () => void }) {
  if (voice.state === "transcribing") {
    // The voice model's first download: how far, as a bar.
    if (voice.downloading !== null) {
      return (
        <Progress value={Math.round(voice.downloading * 100)} className="gap-1.5 px-1 py-1">
          <ProgressLabel className="text-xs font-normal text-muted-foreground">Getting his ears ready, once (about 80 MB)…</ProgressLabel>
          <ProgressValue className="text-xs" />
        </Progress>
      );
    }
    return (
      <div className="flex h-9 items-center gap-2 px-1 text-sm text-muted-foreground" role="status">
        <span className="size-1.5 animate-pulse rounded-full bg-primary" />
        Writing it down…
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2" role="status" aria-label="Listening">
      <Button variant="ghost" size="icon-sm" className="rounded-full text-muted-foreground" aria-label="Stop listening" onClick={onCancel}><XIcon /></Button>
      <div ref={voice.waveform} className="flex h-8 min-w-0 flex-1 items-center gap-[3px]" aria-hidden>
        {Array.from({ length: BARS }, (_, index) => (
          <span key={index} className="h-full w-[3px] flex-1 rounded-full bg-primary motion-safe:transition-transform motion-safe:duration-75" style={{ transform: "scaleY(0.08)" }} />
        ))}
      </div>
      <Button size="sm" className="rounded-full px-3" onClick={onSend}>Send</Button>
    </div>
  );
}

export function MicButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <PetTip label="Talk">
      <Button variant="ghost" size="icon-sm" className={cn("rounded-full text-muted-foreground", className)} aria-label="Talk" onClick={onClick}><MicIcon /></Button>
    </PetTip>
  );
}
