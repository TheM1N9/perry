"use client";

import { useCallback, useEffect, useRef } from "react";
import type { ChatStatus, ChatSummary } from "@/convex/dashboard";

/*
 * What a screen reader hears as chats change state, after T3 Code's ThreadActivityAnnouncer and useLiveRegion
 * (apps/web/src/components/chat/ThreadActivityAnnouncer.tsx, apps/web/src/hooks/useLiveRegion.ts): the open chat
 * starting, needing you and finishing, and other chats finishing while you are elsewhere. The first state seen of a
 * chat is a silent baseline, so opening or switching chats never replays what already happened.
 */

/** NVDA reads a region's leftover text again when focus comes back from a dialog, so it is cleared once spoken. */
const CLEAR_AFTER_MS = 7_000;

/** A polite live region written straight to the DOM, so speaking never re-renders. */
function useLiveRegion() {
  const region = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    if (region.current) region.current.textContent = "";
  }, []);
  const announce = useCallback((text: string) => {
    const node = region.current;
    if (!node) return;
    window.clearTimeout(timer.current);
    // A screen reader skips a write that leaves the text as it was, so a repeat gets a trailing no-break space.
    node.textContent = node.textContent === text ? `${text} ` : text;
    timer.current = window.setTimeout(() => { node.textContent = ""; }, CLEAR_AFTER_MS);
  }, []);
  return { region, announce, clear };
}

/** What a change of the open chat's state sounds like, or null for one not worth a word. */
function spoken(from: ChatStatus | undefined, to: ChatStatus): string | null {
  if (from === undefined || from === to) return null;
  if (to === "running") return from === "needs-approval" ? null : "Working";
  if (to === "needs-approval") return "Needs your approval";
  if (to === "error") return "Failed";
  return from === "running" || from === "needs-approval" ? "Done" : null;
}

/** One polite live region for the open chat. No role="status": Orca maps that to a status bar in Chromium and drops its updates. */
export function ChatAnnouncer({ chatId, status }: { chatId: string | null; status: ChatStatus | undefined }) {
  const { region, announce, clear } = useLiveRegion();
  const last = useRef<{ chatId: string | null; status?: ChatStatus }>({ chatId: null });
  useEffect(() => {
    const before = last.current;
    last.current = { chatId, status };
    if (before.chatId !== chatId) { clear(); return; }
    const text = status && spoken(before.status, status);
    if (text) announce(text);
  }, [chatId, status, announce, clear]);
  return <div ref={region} aria-live="polite" className="sr-only" />;
}

/** Other chats finishing, failing or needing you, said wherever you are, sidebar open or not. */
export function ChatsAnnouncer({ chats, openId }: { chats: ChatSummary[] | undefined; openId: string | null }) {
  const { region, announce } = useLiveRegion();
  // Replaced whole each time, so a deleted chat leaves nothing behind.
  const last = useRef<Map<string, ChatStatus> | null>(null);
  useEffect(() => {
    if (!chats) return;
    const before = last.current;
    last.current = new Map(chats.map((chat) => [chat.id, chat.status]));
    if (!before) return;
    const lines = chats.flatMap((chat) => {
      const from = before.get(chat.id);
      if (chat.id === openId || from === undefined || from === chat.status) return [];
      const what = chat.status === "needs-approval" ? "needs your approval" : chat.status === "error" ? "failed"
        : chat.status === "idle" && from === "running" ? "finished" : null;
      return what ? [`${chat.title || "A chat"} ${what}`] : [];
    });
    if (lines.length) announce(lines.join(". "));
  }, [chats, openId, announce]);
  return <div ref={region} aria-live="polite" className="sr-only" />;
}
