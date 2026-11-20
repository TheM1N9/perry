"use client";

import { useEffect, useRef, useState } from "react";
import { FinalPhrases, type SpeechResult } from "./speech-results";

type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechResult> }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};
const constructor = () => {
  const browser = window as SpeechWindow;
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
};

/** A phrase reported final with no confidence waits this long for a confirmed one before it counts. */
const TENTATIVE_MS = 1_500;

/**
 * The browser owns the microphone; only final phrases become editing instructions. Which results are finished
 * phrases is FinalPhrases' (speech-results.ts): a final counts at once only with a confidence above 0 (Android
 * Chrome reports growing partials as zero-confidence finals); zero-confidence finals wait, each kept in order, and
 * count when nothing confirms them within TENTATIVE_MS or the session ends.
 */
export function useLiveSpeech(onWords: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [phase, setPhase] = useState<"off" | "starting" | "listening" | "stopping">("off");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");
  const recognizer = useRef<Recognition | null>(null);
  const wanted = useRef(false);
  const restart = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const words = useRef(onWords);
  words.current = onWords;
  const stopTentative = useRef(() => {});

  const stop = () => {
    wanted.current = false;
    const restarting = restart.current !== undefined;
    clearTimeout(restart.current);
    restart.current = undefined;
    const current = recognizer.current;
    if (!current) return;
    // An ended service will not send another onend in response to stop().
    if (restarting) {
      recognizer.current = null;
      current.onstart = current.onend = current.onerror = current.onresult = null;
      current.abort();
      setInterim("");
      setPhase("off");
      return;
    }
    setPhase("stopping");
    current.stop();
  };

  useEffect(() => {
    setSupported(Boolean(constructor()) && window.isSecureContext);
    const hidden = () => { if (document.hidden) stop(); };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      stopTentative.current();
      wanted.current = false;
      clearTimeout(restart.current);
      const current = recognizer.current;
      recognizer.current = null;
      if (current) {
        current.onstart = current.onend = current.onerror = current.onresult = null;
        current.abort();
      }
    };
  }, []);

  const start = () => {
    const Speech = constructor();
    if (!Speech || recognizer.current) return;
    const current = new Speech();
    recognizer.current = current;
    wanted.current = true;
    setError("");
    setInterim("");
    setPhase("starting");
    current.continuous = true;
    current.interimResults = true;
    current.lang = navigator.language || "en-US";
    let beganAt = Date.now();
    let shortSessions = 0;
    const phrases = new FinalPhrases();
    let tentativeTimer: ReturnType<typeof setTimeout> | undefined;
    const say = (found: string[]) => {
      const text = found.join(" ").trim();
      if (!text) return;
      shortSessions = 0;
      words.current(text);
    };
    const countTentative = () => {
      clearTimeout(tentativeTimer);
      tentativeTimer = undefined;
      say(phrases.flush());
    };
    stopTentative.current = () => { clearTimeout(tentativeTimer); tentativeTimer = undefined; phrases.clear(); };
    current.onstart = () => {
      phrases.restart();
      beganAt = Date.now();
      setPhase(wanted.current ? "listening" : "stopping");
      if (!wanted.current) current.stop();
    };
    current.onresult = (event) => {
      const read = phrases.read(event.resultIndex, event.results);
      clearTimeout(tentativeTimer);
      tentativeTimer = read.waiting ? setTimeout(countTentative, TENTATIVE_MS) : undefined;
      say(read.say);
      setInterim(read.interim);
    };
    current.onerror = (event) => {
      if (event.error === "no-speech" || (event.error === "aborted" && !wanted.current)) return;
      wanted.current = false;
      setError(event.error === "not-allowed" || event.error === "service-not-allowed"
        ? "Allow microphone and speech recognition access in your browser, then try again."
        : event.error === "audio-capture"
          ? "No microphone is available. Check your microphone, then try again."
          : `Speech recognition stopped (${event.error}). Check your connection, or type an instruction below.`);
    };
    current.onend = () => {
      countTentative();
      setInterim("");
      if (Date.now() - beganAt < 1_000) shortSessions++;
      else shortSessions = 0;
      if (wanted.current && shortSessions < 3) {
        setPhase("starting");
        restart.current = setTimeout(() => { restart.current = undefined; begin(); }, 300);
      } else {
        if (wanted.current) setError("The browser keeps stopping speech recognition. Try again, or type an instruction below.");
        wanted.current = false;
        recognizer.current = null;
        setPhase("off");
      }
    };
    function begin() {
      if (recognizer.current !== current || !wanted.current) return;
      try { current.start(); }
      catch (cause) {
        wanted.current = false;
        recognizer.current = null;
        setPhase("off");
        setError(`Couldn't start listening: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    begin();
  };

  return { supported, phase, interim, error, start, stop };
}
