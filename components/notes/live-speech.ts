"use client";

import { useEffect, useRef, useState } from "react";

type Result = { isFinal: boolean; 0: { transcript: string; confidence: number } };
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

/** A phrase reported final with no confidence waits this long for a confirmed one before it counts. */
const TENTATIVE_MS = 1_500;

/**
 * The browser owns the microphone; only final phrases become editing instructions.
 *
 * Android Chrome reports `isFinal` for growing partials too, each at a new index, with a confidence of 0; its
 * real final has a confidence above 0. So a final counts only with confidence. A browser that reports 0 even for
 * real finals still gets its words in: a zero-confidence final is held as tentative, replaced by any later
 * tentative, and counted when nothing confirms it within TENTATIVE_MS or the session ends. A confirmed final
 * after a tentative one was counted adds only what is new.
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
    let finalThrough = -1;
    let beganAt = Date.now();
    let shortSessions = 0;
    let tentative = "";
    let counted = "";
    let tentativeTimer: ReturnType<typeof setTimeout> | undefined;
    const say = (text: string) => {
      const phrase = text.trim();
      if (!phrase) return;
      shortSessions = 0;
      words.current(phrase);
    };
    const countTentative = () => {
      clearTimeout(tentativeTimer);
      tentativeTimer = undefined;
      if (!tentative) return;
      say(tentative);
      counted = tentative.trim();
      tentative = "";
    };
    stopTentative.current = () => { clearTimeout(tentativeTimer); tentativeTimer = undefined; };
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
        if (result.isFinal && result[0].confidence > 0) {
          if (index > finalThrough) final.push(result[0].transcript);
          finalThrough = Math.max(finalThrough, index);
        } else if (result.isFinal) {
          if (index > finalThrough) tentative = result[0].transcript;
        } else partial.push(result[0].transcript);
      }
      if (final.length) {
        clearTimeout(tentativeTimer);
        tentativeTimer = undefined;
        tentative = "";
        let text = final.join(" ").trim();
        if (counted && text.startsWith(counted)) text = text.slice(counted.length);
        counted = "";
        say(text);
      } else if (tentative) {
        clearTimeout(tentativeTimer);
        tentativeTimer = setTimeout(countTentative, TENTATIVE_MS);
      }
      setInterim([tentative, ...partial].filter(Boolean).join(" "));
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
