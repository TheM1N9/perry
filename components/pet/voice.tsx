"use client";

import { MicIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Talking to Perry: the microphone, recorded here in the page while he
 * listens, and turned into text by his window (pet/voice.js), on this
 * computer. What you say goes into his chat.
 */

type Transcribed = { text?: string; error?: string };
export type HotkeyState = { hotkey: string | null; error: string | null };
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
  /** How loud it is now, 0 to 1, and the last few, for the waveform. */
  levels: number[];
  /** How far the voice model's first download has got, 0 to 1, while it downloads. */
  downloading: number | null;
  error: string;
  start: () => Promise<void>;
  /** Stop listening and return what was said ("" for nothing). */
  stop: () => Promise<string>;
  cancel: () => void;
};

const BARS = 28;
const SAMPLE_RATE = 16_000;

export function useVoice(bridge: VoiceBridge | undefined): Voice {
  const [state, setState] = useState<VoiceState>("idle");
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0));
  const [downloading, setDownloading] = useState<number | null>(null);
  const [error, setError] = useState("");
  const live = useRef<{ stream: MediaStream; recorder: MediaRecorder; chunks: Blob[]; context: AudioContext; timer: number } | null>(null);

  // The first time, the model downloads (a few files); its progress is all of them together.
  useEffect(() => {
    if (!bridge) return;
    const files = new Map<string, Progress>();
    return bridge.onVoiceProgress((progress) => {
      files.set(progress.file, progress);
      const all = [...files.values()];
      const share = all.reduce((sum, file) => sum + file.loaded, 0) / Math.max(1, all.reduce((sum, file) => sum + file.total, 0));
      setDownloading(share >= 1 ? null : share);
    });
  }, [bridge]);

  const release = useCallback(() => {
    const current = live.current;
    live.current = null;
    if (!current) return;
    window.clearInterval(current.timer);
    for (const track of current.stream.getTracks()) track.stop();
    void current.context.close().catch(() => {});
    setLevels(Array(BARS).fill(0));
  }, []);

  const start = useCallback(async () => {
    if (live.current) return;
    setError("");
    try {
      // As OpenWhispr does: the browser's echo and noise filters blur words, and Whisper copes with a room better than they do.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.start(250);
      // The waveform: how loud, every 80 ms.
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const wave = new Uint8Array(analyser.fftSize);
      const timer = window.setInterval(() => {
        analyser.getByteTimeDomainData(wave);
        let sum = 0;
        for (const value of wave) sum += ((value - 128) / 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / wave.length) * 4);
        setLevels((previous) => [...previous.slice(1), level]);
      }, 80);
      live.current = { stream, recorder, chunks, context, timer };
      setState("listening");
    } catch (cause) {
      setError(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? "He can't hear you: allow the microphone for Perry in your system's privacy settings."
        : `He can't hear you: ${cause instanceof Error ? cause.message : String(cause)}`);
      setState("idle");
    }
  }, []);

  const stop = useCallback(async (): Promise<string> => {
    const current = live.current;
    if (!current || !bridge) return "";
    const stopped = new Promise<void>((done) => { current.recorder.onstop = () => done(); });
    current.recorder.stop();
    await stopped;
    release();
    setState("transcribing");
    try {
      // Whisper hears 16 kHz mono; decoding at that rate resamples it.
      const decoder = new AudioContext({ sampleRate: SAMPLE_RATE });
      const audio = await decoder.decodeAudioData(await new Blob(current.chunks, { type: current.recorder.mimeType }).arrayBuffer());
      void decoder.close();
      const samples = audio.numberOfChannels === 1 ? audio.getChannelData(0)
        : Float32Array.from(audio.getChannelData(0), (value, index) => (value + audio.getChannelData(1)[index]) / 2);
      // Under a third of a second is a slip of the key, not something said.
      if (samples.length < SAMPLE_RATE / 3) return "";
      const result = await bridge.transcribe(samples);
      if (result.error) setError(`He couldn't make that out: ${result.error}`);
      return result.text ?? "";
    } catch (cause) {
      setError(`He couldn't make that out: ${cause instanceof Error ? cause.message : String(cause)}`);
      return "";
    } finally {
      setDownloading(null);
      setState("idle");
    }
  }, [bridge, release]);

  const cancel = useCallback(() => {
    live.current?.recorder.stop();
    release();
    setState("idle");
  }, [release]);

  useEffect(() => release, [release]);
  return { state, levels, downloading, error, start, stop, cancel };
}

/** Where the composer was, while he listens: the waveform, and how to send or stop. */
export function Listening({ voice, onSend, onCancel }: { voice: Voice; onSend: () => void; onCancel: () => void }) {
  if (voice.state === "transcribing") {
    return (
      <div className="flex h-9 items-center gap-2 px-1 text-[13px] text-muted-foreground" role="status">
        <span className="size-1.5 animate-pulse rounded-full bg-primary" />
        {voice.downloading !== null
          ? `Getting his ears ready, once (about 80 MB)… ${Math.round(voice.downloading * 100)}%`
          : "Writing it down…"}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2" role="status" aria-label="Listening">
      <button type="button" aria-label="Stop listening" onClick={onCancel}
        className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
        <XIcon className="size-4" aria-hidden />
      </button>
      <div className="flex h-8 min-w-0 flex-1 items-center gap-[3px]" aria-hidden>
        {voice.levels.map((level, index) => (
          <span key={index} className="w-[3px] flex-1 rounded-full bg-primary transition-[height] duration-75" style={{ height: `${Math.max(8, level * 100)}%` }} />
        ))}
      </div>
      <button type="button" onClick={onSend}
        className="h-7 shrink-0 cursor-pointer rounded-full bg-primary px-3 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90">
        Send
      </button>
    </div>
  );
}

export function MicButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button type="button" aria-label="Talk" title="Talk" onClick={onClick}
      className={cn("grid size-7 shrink-0 cursor-pointer place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground", className)}>
      <MicIcon className="size-4" aria-hidden />
    </button>
  );
}
