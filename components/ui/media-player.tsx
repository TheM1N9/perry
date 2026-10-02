"use client";

import {
  DownloadIcon, MaximizeIcon, MinimizeIcon, PauseIcon, PictureInPicture2Icon, PlayIcon, Volume1Icon, Volume2Icon, VolumeXIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Perry's media player (issue #217): one for video, one for audio and voice
 * notes, both on the browser's own <video> and <audio> underneath, with
 * controls in Perry's style instead of each browser's. Used wherever media
 * plays: chat attachments, the Library (#216).
 *
 * Only one plays at a time: starting one pauses whichever was playing. Where
 * each file was left is remembered for the session, so it carries on there.
 * Keys, on a focused player: space or k to play and pause, ←/→ 5 s, j/l 10 s,
 * ↑/↓ volume, m to mute, f for full screen (video).
 */

/** The one playing now; starting another pauses it. */
let playing: HTMLMediaElement | null = null;
/** Where each file was left, this session. */
const positions = new Map<string, number>();
/** Each audio file's waveform, worked out once a session. */
const waveforms = new Map<string, Promise<number[]>>();

const SPEEDS_VIDEO = [0.5, 0.75, 1, 1.25, 1.5, 2];
const SPEEDS_AUDIO = [1, 1.5, 2];
const BARS = 48;
/** Past this a file is not downloaded again to draw its waveform. */
const WAVEFORM_MAX_BYTES = 25 * 1024 * 1024;

export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A time as a screen reader says it. */
function spoken(seconds: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return m ? `${m} minute${m === 1 ? "" : "s"} ${s} second${s === 1 ? "" : "s"}` : `${s} second${s === 1 ? "" : "s"}`;
}

/** The loudness of each stretch of the file, 0 to 1, from the file itself. */
function waveformOf(src: string): Promise<number[]> {
  const known = waveforms.get(src);
  if (known) return known;
  const work = (async () => {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`${response.status}`);
    if (Number(response.headers.get("content-length") ?? 0) > WAVEFORM_MAX_BYTES) throw new Error("too big");
    const data = await response.arrayBuffer();
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new Context();
    try {
      const audio = await context.decodeAudioData(data);
      const samples = audio.getChannelData(0);
      const step = Math.max(1, Math.floor(samples.length / BARS));
      const peaks = Array.from({ length: BARS }, (_, bar) => {
        let sum = 0;
        const start = bar * step;
        const end = Math.min(samples.length, start + step);
        for (let i = start; i < end; i++) sum += samples[i] * samples[i];
        return Math.sqrt(sum / Math.max(1, end - start));
      });
      const loudest = Math.max(...peaks, 1e-6);
      return peaks.map((peak) => Math.max(0.06, peak / loudest));
    } finally {
      void context.close();
    }
  })();
  waveforms.set(src, work);
  work.catch(() => waveforms.delete(src));
  return work;
}

/** What both players share: the element's state, one-at-a-time, the remembered place and the keys. */
function useMedia<T extends HTMLMediaElement>(src: string) {
  const ref = useRef<T>(null);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);

  useEffect(() => {
    const media = ref.current;
    if (!media) return;
    const sync = () => {
      setPaused(media.paused);
      setTime(media.currentTime);
      setDuration(Number.isFinite(media.duration) ? media.duration : 0);
      setVolume(media.volume);
      setMuted(media.muted);
      setRate(media.playbackRate);
      const ranges = media.buffered;
      setBuffered(ranges.length ? ranges.end(ranges.length - 1) : 0);
    };
    const onPlay = () => {
      if (playing && playing !== media) playing.pause();
      playing = media;
      sync();
    };
    const onPause = () => { if (playing === media) playing = null; sync(); };
    const onTime = () => {
      if (probing) return;
      setTime(media.currentTime);
      if (media.currentTime > 0) positions.set(src, media.currentTime);
    };
    // A recording made in a browser (a WebM) can say nothing of its length: asking for a time past its end makes it work it out.
    let probing = false;
    const onMeta = () => {
      if (media.duration === Infinity) {
        probing = true;
        media.currentTime = 1e101;
        return;
      }
      const saved = positions.get(src);
      if (saved && Number.isFinite(media.duration) && saved < media.duration - 0.5) media.currentTime = saved;
      sync();
    };
    const onDuration = () => {
      if (probing && Number.isFinite(media.duration)) {
        probing = false;
        media.currentTime = 0;
        onMeta();
        return;
      }
      sync();
    };
    const onEnded = () => { positions.delete(src); sync(); };
    const events: Array<[string, () => void]> = [
      ["play", onPlay], ["pause", onPause], ["timeupdate", onTime], ["loadedmetadata", onMeta], ["durationchange", onDuration],
      ["progress", sync], ["volumechange", sync], ["ratechange", sync], ["ended", onEnded], ["seeked", sync],
    ];
    for (const [name, handler] of events) media.addEventListener(name, handler);
    if (media.readyState >= 1) onMeta();
    return () => {
      for (const [name, handler] of events) media.removeEventListener(name, handler);
      if (playing === media) playing = null;
    };
  }, [src]);

  const toggle = useCallback(() => {
    const media = ref.current;
    if (!media) return;
    if (media.paused) void media.play().catch(() => {});
    else media.pause();
  }, []);
  const seek = useCallback((to: number) => {
    const media = ref.current;
    if (!media || !Number.isFinite(media.duration)) return;
    media.currentTime = Math.min(Math.max(0, to), media.duration);
    setTime(media.currentTime);
  }, []);
  const changeVolume = useCallback((to: number) => {
    const media = ref.current;
    if (!media) return;
    media.volume = Math.min(1, Math.max(0, to));
    media.muted = media.volume === 0;
  }, []);
  const toggleMute = useCallback(() => {
    const media = ref.current;
    if (!media) return;
    media.muted = !media.muted;
    if (!media.muted && media.volume === 0) media.volume = 0.5;
  }, []);
  const changeRate = useCallback((to: number) => { if (ref.current) ref.current.playbackRate = to; }, []);

  /** The player's keys; true when the key was one of them. */
  const onKey = useCallback((event: KeyboardEvent, extra?: (key: string) => boolean): boolean => {
    const media = ref.current;
    if (!media || event.altKey || event.ctrlKey || event.metaKey) return false;
    // A range control takes its own arrow keys.
    const onRange = (event.target as HTMLElement).tagName === "INPUT" && /^Arrow/.test(event.key);
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    let handled = true;
    if (key === " " || key === "k") {
      if ((event.target as HTMLElement).tagName === "BUTTON" && key === " ") return false;
      toggle();
    } else if (key === "ArrowLeft" && !onRange) seek(media.currentTime - 5);
    else if (key === "ArrowRight" && !onRange) seek(media.currentTime + 5);
    else if (key === "j") seek(media.currentTime - 10);
    else if (key === "l") seek(media.currentTime + 10);
    else if (key === "ArrowUp" && !onRange) changeVolume(media.volume + 0.1);
    else if (key === "ArrowDown" && !onRange) changeVolume(media.volume - 0.1);
    else if (key === "m") toggleMute();
    else handled = extra?.(key) ?? false;
    if (handled) event.preventDefault();
    return handled;
  }, [changeVolume, seek, toggle, toggleMute]);

  return { ref, paused, time, duration, buffered, volume, muted, rate, toggle, seek, changeVolume, toggleMute, changeRate, onKey };
}

const ring = "outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

function ControlButton({ label, onClick, children, className, pressed }: { label: string; onClick: () => void; children: ReactNode; className?: string; pressed?: boolean }) {
  return (
    <button type="button" aria-label={label} aria-pressed={pressed} onClick={onClick} title={label}
      className={cn("grid size-8 shrink-0 cursor-pointer place-items-center rounded-md [&_svg]:size-4", ring, className)}>
      {children}
    </button>
  );
}

function DownloadButton({ href, name, className }: { href: string; name: string; className?: string }) {
  return (
    <a href={href} download={name} aria-label={`Download ${name}`} title="Download"
      className={cn("grid size-8 shrink-0 place-items-center rounded-md [&_svg]:size-4", ring, className)}>
      <DownloadIcon />
    </a>
  );
}

/** A thin bar to drag: a range input over a drawn track, so the keyboard and screen readers get a real slider. */
function Bar({ label, value, max, step, onChange, buffered, valueText, className, onHover }: {
  label: string; value: number; max: number; step: number; onChange: (value: number) => void; buffered?: number; valueText: string; className?: string;
  onHover?: (at: number | null, x: number) => void;
}) {
  const share = max > 0 ? Math.min(1, value / max) : 0;
  const loaded = max > 0 && buffered !== undefined ? Math.min(1, buffered / max) : 0;
  const hover = (event: PointerEvent<HTMLInputElement>) => {
    if (!onHover) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(0, event.clientX - box.left), box.width);
    onHover(box.width ? (x / box.width) * max : 0, x);
  };
  return (
    <div className={cn("group/bar relative flex h-4 items-center", className)}>
      <div className="pointer-events-none absolute inset-x-0 h-1 overflow-hidden rounded-full bg-current/20 transition-[height] group-hover/bar:h-1.5">
        {buffered !== undefined && <div className="absolute inset-y-0 left-0 bg-current/25" style={{ width: `${loaded * 100}%` }} />}
        <div className="absolute inset-y-0 left-0 bg-current" style={{ width: `${share * 100}%` }} />
      </div>
      <div className="pointer-events-none absolute size-3 -translate-x-1/2 rounded-full bg-current opacity-0 transition-opacity group-hover/bar:opacity-100 group-has-focus-visible/bar:opacity-100" style={{ left: `${share * 100}%` }} />
      <input type="range" aria-label={label} aria-valuetext={valueText} min={0} max={max || 0} step={step} value={Math.min(value, max || 0)}
        onChange={(event) => onChange(Number(event.target.value))} onPointerMove={hover} onPointerLeave={() => onHover?.(null, 0)}
        className={cn("absolute inset-0 w-full cursor-pointer appearance-none bg-transparent opacity-0", "peer")} />
      <span className="pointer-events-none absolute -inset-1 rounded-md ring-ring/60 group-has-[input:focus-visible]/bar:ring-2" aria-hidden />
    </div>
  );
}

function VolumeIcon({ volume, muted }: { volume: number; muted: boolean }) {
  return muted || volume === 0 ? <VolumeXIcon /> : volume < 0.5 ? <Volume1Icon /> : <Volume2Icon />;
}

/**
 * A video: its first frame as the poster, a big play button, and controls
 * that fade while it plays. Click to play or pause, double-click for full screen.
 */
export function VideoPlayer({ src, name, download, className }: { src: string; name: string; download?: string; className?: string }) {
  const media = useMedia<HTMLVideoElement>(src);
  const box = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [pip, setPip] = useState(false);
  const [canPip, setCanPip] = useState(false);
  const [awake, setAwake] = useState(true);
  const [hoverAt, setHoverAt] = useState<{ at: number; x: number } | null>(null);
  const [started, setStarted] = useState(false);
  const sleepTimer = useRef<number>(undefined);

  useEffect(() => {
    setCanPip(typeof document !== "undefined" && document.pictureInPictureEnabled === true);
    const onFull = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", onFull);
    const video = media.ref.current;
    const enter = () => setPip(true);
    const leave = () => setPip(false);
    video?.addEventListener("enterpictureinpicture", enter);
    video?.addEventListener("leavepictureinpicture", leave);
    return () => {
      document.removeEventListener("fullscreenchange", onFull);
      video?.removeEventListener("enterpictureinpicture", enter);
      video?.removeEventListener("leavepictureinpicture", leave);
    };
  }, [media.ref]);
  useEffect(() => { if (!media.paused) setStarted(true); }, [media.paused]);
  // The controls show while paused, and for a moment after the pointer moves while it plays.
  const wake = useCallback(() => {
    setAwake(true);
    window.clearTimeout(sleepTimer.current);
    sleepTimer.current = window.setTimeout(() => setAwake(false), 2500);
  }, []);
  useEffect(() => () => window.clearTimeout(sleepTimer.current), []);
  useEffect(() => { if (media.paused) setAwake(true); else wake(); }, [media.paused, wake]);

  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void box.current?.requestFullscreen?.().catch(() => {});
  };
  const togglePip = () => {
    const video = media.ref.current;
    if (!video) return;
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
    else void video.requestPictureInPicture?.().catch(() => {});
  };
  const cycleRate = () => {
    const at = SPEEDS_VIDEO.indexOf(media.rate);
    media.changeRate(SPEEDS_VIDEO[(at + 1) % SPEEDS_VIDEO.length]);
  };
  const shown = awake || media.paused;

  return (
    <div ref={box} tabIndex={0} role="group" aria-label={`Video: ${name}`} data-media-player="video" data-playing={!media.paused || undefined}
      onKeyDown={(event) => media.onKey(event, (key) => { if (key === "f") { toggleFull(); return true; } return false; })}
      onPointerMove={wake} onFocus={wake}
      className={cn("group/player relative overflow-hidden rounded-xl bg-black text-white", ring, full ? "flex items-center justify-center rounded-none" : "", !shown && "cursor-none", className)}>
      {/* #t=0.1 makes the first frame the poster, where a browser would show black. */}
      <video ref={media.ref} src={`${src}#t=0.1`} preload="metadata" playsInline aria-label={name}
        onClick={media.toggle} onDoubleClick={toggleFull}
        className={cn("block max-h-[inherit] w-full bg-black object-contain", full && "h-full max-h-none")} />
      {media.paused && (
        <button type="button" aria-label={`Play ${name}`} onClick={media.toggle} data-big-play
          className={cn("absolute top-1/2 left-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 cursor-pointer place-items-center rounded-full bg-black/55 backdrop-blur-sm transition-transform hover:scale-105 [&_svg]:size-6", ring)}>
          <PlayIcon className="translate-x-px fill-current" />
        </button>
      )}
      <div data-controls className={cn("absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/35 to-transparent px-2 pt-8 pb-1.5 transition-opacity duration-300",
        shown ? "opacity-100" : "pointer-events-none opacity-0", !started && media.paused && "from-black/50")}>
        <div className="relative px-1">
          {hoverAt && media.duration > 0 && (
            <span className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded bg-black/80 px-1.5 py-0.5 text-2xs nums" style={{ left: hoverAt.x + 4 }}>{clock(hoverAt.at)}</span>
          )}
          <Bar label="Seek" value={media.time} max={media.duration} step={0.1} buffered={media.buffered} onChange={media.seek}
            valueText={`${spoken(media.time)} of ${spoken(media.duration)}`} onHover={(at, x) => setHoverAt(at === null ? null : { at, x })} />
        </div>
        <div className="flex items-center gap-0.5">
          <ControlButton label={media.paused ? "Play" : "Pause"} onClick={media.toggle}>
            {media.paused ? <PlayIcon className="fill-current" /> : <PauseIcon className="fill-current" />}
          </ControlButton>
          <div className="group/volume flex items-center">
            <ControlButton label={media.muted ? "Unmute" : "Mute"} onClick={media.toggleMute} pressed={media.muted}>
              <VolumeIcon volume={media.volume} muted={media.muted} />
            </ControlButton>
            <Bar label="Volume" value={media.muted ? 0 : media.volume} max={1} step={0.05} onChange={media.changeVolume}
              valueText={`${Math.round((media.muted ? 0 : media.volume) * 100)}%`}
              className="w-0 overflow-hidden opacity-0 transition-all group-focus-within/volume:mr-2 group-focus-within/volume:w-16 group-focus-within/volume:opacity-100 group-hover/volume:mr-2 group-hover/volume:w-16 group-hover/volume:opacity-100" />
          </div>
          <span className="px-1 text-xs nums" aria-hidden>{clock(media.time)} / {clock(media.duration)}</span>
          <span className="sr-only" role="timer" aria-live="off">{spoken(media.time)} of {spoken(media.duration)}</span>
          <span className="flex-1" />
          <button type="button" onClick={cycleRate} aria-label={`Speed ${media.rate}×`} title="Speed"
            className={cn("h-8 min-w-10 cursor-pointer rounded-md px-1.5 text-xs font-medium nums", ring)}>{media.rate}×</button>
          {canPip && <ControlButton label={pip ? "Leave picture-in-picture" : "Picture-in-picture"} onClick={togglePip} pressed={pip}><PictureInPicture2Icon /></ControlButton>}
          {download && <DownloadButton href={download} name={name} />}
          <ControlButton label={full ? "Leave full screen" : "Full screen"} onClick={toggleFull}>{full ? <MinimizeIcon /> : <MaximizeIcon />}</ControlButton>
        </div>
      </div>
    </div>
  );
}

/**
 * Audio and voice notes: play, a waveform to click or drag along, the time,
 * the speed (1×, 1.5×, 2×) and a download, in one compact row.
 */
export function AudioPlayer({ src, name, download, className, compact }: { src: string; name: string; download?: string; className?: string; compact?: boolean }) {
  const media = useMedia<HTMLAudioElement>(src);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    let current = true;
    waveformOf(src).then((found) => { if (current) setPeaks(found); }, () => { if (current) setPeaks([]); });
    return () => { current = false; };
  }, [src]);
  const bars = peaks?.length ? peaks : Array.from({ length: BARS }, () => 0.18);
  const share = media.duration > 0 ? media.time / media.duration : 0;
  const cycleRate = () => {
    const at = SPEEDS_AUDIO.indexOf(media.rate);
    media.changeRate(SPEEDS_AUDIO[(at + 1) % SPEEDS_AUDIO.length]);
  };
  return (
    <div role="group" aria-label={`Audio: ${name}`} tabIndex={0} onKeyDown={(event) => media.onKey(event)} data-media-player="audio"
      data-playing={!media.paused || undefined} data-waveform={peaks === null ? "loading" : peaks.length ? "ready" : "none"}
      className={cn("flex w-full max-w-sm items-center gap-2 rounded-xl border bg-background py-1.5 pr-1.5 pl-1.5", ring, className)}>
      <audio ref={media.ref} src={src} preload="metadata" />
      <button type="button" aria-label={media.paused ? `Play ${name}` : `Pause ${name}`} onClick={media.toggle}
        className={cn("grid size-8 shrink-0 cursor-pointer place-items-center rounded-full bg-primary text-primary-foreground [&_svg]:size-3.5", ring)}>
        {media.paused ? <PlayIcon className="translate-x-px fill-current" /> : <PauseIcon className="fill-current" />}
      </button>
      <div className="relative h-8 min-w-0 flex-1">
        <div className="pointer-events-none absolute inset-0 flex items-center gap-px overflow-hidden" aria-hidden>
          {bars.map((peak, index) => (
            <span key={index} className={cn("min-w-0 flex-1 rounded-full transition-colors", (index + 0.5) / bars.length <= share ? "bg-primary" : "bg-muted-foreground/35")}
              style={{ height: `${Math.round(peak * 100)}%` }} />
          ))}
        </div>
        <input type="range" aria-label="Seek" aria-valuetext={`${spoken(media.time)} of ${spoken(media.duration)}`} min={0} max={media.duration || 0} step={0.05}
          value={Math.min(media.time, media.duration || 0)} onChange={(event) => media.seek(Number(event.target.value))}
          className="peer absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0" />
        <span className="pointer-events-none absolute -inset-1 rounded-md ring-ring/60 peer-focus-visible:ring-2" aria-hidden />
      </div>
      <span className={cn("shrink-0 text-right text-xs text-muted-foreground nums", compact ? "w-9" : "w-12")} aria-hidden>
        {media.paused && media.time === 0 ? clock(media.duration) : `${clock(media.time)}`}
      </span>
      <span className="sr-only">{spoken(media.time)} of {spoken(media.duration)}</span>
      {!compact && <button type="button" onClick={cycleRate} aria-label={`Speed ${media.rate}×`} title="Speed"
        className={cn("h-7 min-w-9 shrink-0 cursor-pointer rounded-md px-1 text-xs font-medium text-muted-foreground nums hover:bg-muted hover:text-foreground", ring)}>{media.rate}×</button>}
      {download && !compact && <DownloadButton href={download} name={name} className="size-7 text-muted-foreground hover:bg-muted hover:text-foreground" />}
    </div>
  );
}

/** A video or an audio file, whichever it is. */
export function MediaPlayer({ src, name, contentType, download, className }: { src: string; name: string; contentType: string; download?: string; className?: string }) {
  if (contentType.startsWith("video/")) return <VideoPlayer src={src} name={name} download={download} className={className} />;
  return <AudioPlayer src={src} name={name} download={download} className={className} />;
}
