"use client";

import { useEffect, useRef, useState } from "react";

type Result = { isFinal: boolean; 0: { transcript: string } };
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: { resultIndex: number; results: ArrayLike<Result> }) => void) | null;
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

/** The browser owns the microphone; only final phrases become editing instructions. */
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
    let finalThrough = -1;
    let beganAt = Date.now();
    let shortSessions = 0;
    current.onstart = () => {
      finalThrough = -1;
      beganAt = Date.now();
      setPhase(wanted.current ? "listening" : "stopping");
      if (!wanted.current) current.stop();
    };
    current.onresult = (event) => {
      const final: string[] = [];
      const partial: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        if (result.isFinal) {
          if (index > finalThrough) final.push(result[0].transcript);
          finalThrough = Math.max(finalThrough, index);
        } else partial.push(result[0].transcript);
      }
      setInterim(partial.join(" "));
      if (final.length) {
        shortSessions = 0;
        const text = final.join(" ").trim();
        if (text) words.current(text);
      }
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
