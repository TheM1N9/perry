"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { errorText } from "@/lib/format";
import type { HotkeyState } from "./voice";

export type ListeningState = {
  phase: "off" | "starting" | "listening" | "stopping";
  id?: string; title?: string; startedAt?: number; mic?: string; system?: string;
  behindMs?: number; droppedMs?: number; progress?: number; error?: string;
  callActive?: boolean | null;
  speech?: string;
};
type ListenAsk = { title?: string; eventId?: string; joinUrl?: string; askedId?: string };
export type MeetingBridge = {
  meetingControls?: boolean;
  meetingState?: () => Promise<ListeningState>;
  onMeeting?: (listener: (state: ListeningState) => void) => () => void;
  startMeeting?: (ask?: ListenAsk) => Promise<ListeningState>;
  stopMeeting?: () => Promise<ListeningState>;
  onCallActive?: (listener: (active: boolean) => void) => () => void;
  setListenHotkey?: (accelerator: string) => Promise<HotkeyState>;
  show?: () => void;
  setMeetingSuggestions?: (config: { paused: boolean; headsUp: boolean; notice: boolean; upcoming: Array<{ eventId: string; title: string; startsAt: number; endsAt: number; joinUrl?: string }> }) => void;
};

export function useMeetings(key: string, now: number, paused: boolean) {
  const bridge = typeof window === "undefined" ? undefined : window.perryPet;
  const connection = useConnection();
  const data = useQuery(api.meetings.pet, bridge?.meetingState ? { key } : "skip");
  const shortcuts = useQuery(api.dashboard.getShortcuts, bridge?.meetingState ? { key } : "skip");
  const dismiss = useMutation(api.meetings.dismissUpcoming);
  const [state, setState] = useState<ListeningState>({ phase: "off" });
  const [call, setCall] = useState(false);
  const [callHidden, setCallHidden] = useState(false);
  const [hotkey, setHotkey] = useState<HotkeyState>({ hotkey: null, error: null });
  const asked = useRef<string | null>(null);
  const shown = useRef<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!bridge?.meetingState) return;
    let mounted = true;
    let received = false;
    const off = bridge.onMeeting?.((next) => { received = true; if (mounted) setState(next); });
    void bridge.meetingState().then((next) => {
      if (mounted && !received) {
        setState(next);
        if (typeof next.callActive === "boolean") setCall(next.callActive);
      }
    }, () => {});
    const offCall = bridge.onCallActive?.((active) => { setCall(active); if (!active) setCallHidden(false); });
    return () => { mounted = false; off?.(); offCall?.(); };
  }, [bridge]);
  const start = useCallback(async (ask: ListenAsk = {}) => {
    if (busy.current || !bridge?.startMeeting) return;
    busy.current = true;
    try { setCallHidden(true); setState(await bridge.startMeeting(ask)); }
    catch (error) { setState({ phase: "off", error: errorText(error) }); }
    finally { busy.current = false; }
  }, [bridge]);
  const stop = useCallback(() => {
    void bridge?.stopMeeting?.().catch((error) => setState((current) => ({ ...current, error: errorText(error) })));
  }, [bridge]);

  useEffect(() => {
    if (data?.asked && asked.current !== data.asked.id && state.phase === "off") {
      asked.current = data.asked.id;
      void start({ askedId: data.asked.id });
    }
    if (data?.listening?.stopAsked && data.listening.id === state.id && state.phase === "listening") stop();
  }, [data?.asked?.id, data?.listening?.stopAsked, data?.listening?.id, state.id, state.phase, start, stop]);
  useEffect(() => {
    const keys = shortcuts?.shortcuts.listen;
    if (!keys) return;
    let mounted = true;
    void bridge?.setListenHotkey?.(keys).then((result) => { if (mounted) setHotkey(result); }, () => {});
    return () => { mounted = false; };
  }, [bridge, shortcuts?.shortcuts.listen]);

  useEffect(() => {
    if (!bridge?.setMeetingSuggestions || !data) return;
    const send = () => bridge.setMeetingSuggestions?.({ paused: paused || connection !== "connected", headsUp: data.headsUp, notice: data.notice, upcoming: data.upcoming });
    send();
    const timer = setInterval(send, 30_000);
    return () => clearInterval(timer);
  }, [bridge, data, paused, connection]);
  useEffect(() => () => {
    bridge?.setMeetingSuggestions?.({ paused: true, headsUp: false, notice: false, upcoming: [] });
  }, [bridge]);

  const upcoming = !bridge?.setMeetingSuggestions && !paused && data?.headsUp && state.phase === "off"
    ? data.upcoming.find((event) => now >= event.startsAt - 2 * 60_000 && now <= event.startsAt + 10 * 60_000 && now < event.endsAt)
    : undefined;
  const notice = !bridge?.setMeetingSuggestions && !paused && state.phase === "off" && data?.notice && call && !callHidden;
  const prompt = upcoming?.eventId ?? (notice ? "call" : null);
  useEffect(() => {
    if (prompt && prompt !== shown.current) bridge?.show?.();
    shown.current = prompt;
  }, [bridge, prompt]);

  return {
    state, upcoming, notice, start, stop, hotkey, nativeControls: bridge?.meetingControls === true,
    dismiss: () => {
      if (upcoming) void dismiss({ key, eventId: upcoming.eventId }).catch((error) => setState({ phase: "off", error: errorText(error) }));
      else setCallHidden(true);
    },
    clearError: () => setState({ phase: "off" }),
  };
}
