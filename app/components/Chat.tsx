"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";

/**
 * The same agent Telegram talks to, on a separate conversation so the two
 * histories do not tangle. Memories are shared, which is the point: teach Perry
 * something here and it knows it on your phone.
 */
export function Chat({ dashboardKey }: { dashboardKey: string }) {
  const chat = useQuery(api.dashboard.getChat, { key: dashboardKey });
  const send = useMutation(api.dashboard.sendChat);
  const setMode = useMutation(api.dashboard.setChatMode);

  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const messages = chat?.messages ?? [];

  // The optimistic bubble stays until the real user message lands in the
  // thread, which happens when the agent saves the prompt.
  useEffect(() => {
    if (pending && messages.some((m) => m.role === "user" && m.text === pending)) {
      setPending(null);
    }
  }, [messages, pending]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages.length, pending]);

  const submit = async () => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    setPending(text);
    try {
      await send({ key: dashboardKey, text });
    } catch (error) {
      setPending(null);
      setDraft(text);
      throw error;
    }
  };

  const waiting =
    pending !== null ||
    (messages.length > 0 && messages[messages.length - 1]?.role === "user");

  return (
    <div className="panel">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3>Chat</h3>
        <div className="row" style={{ gap: 6 }}>
          {(["perry", "agentP"] as const).map((mode) => (
            <button
              key={mode}
              className={chat?.mode === mode ? "primary" : "ghost"}
              disabled={!chat?.mode}
              onClick={() => setMode({ key: dashboardKey, mode })}
            >
              {mode === "perry" ? "Perry" : "Agent P"}
            </button>
          ))}
        </div>
      </div>
      <p className="hint">
        Shares memory with Telegram. Slash commands work here too.
      </p>

      <div className="messages" ref={scroller}>
        {chat === undefined && <div className="empty">Loading.</div>}
        {chat !== undefined && messages.length === 0 && pending === null && (
          <div className="empty">
            Nothing yet. Try: remember that I drink coffee black
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={m.role === "user" ? "msg user" : "msg assistant"}
          >
            {m.text}
          </div>
        ))}
        {pending !== null && <div className="msg user pending">{pending}</div>}
        {waiting && <div className="msg assistant pending">thinking</div>}
      </div>

      <div className="composer">
        <textarea
          value={draft}
          placeholder="Message Perry"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button
          className="primary"
          onClick={() => void submit()}
          disabled={draft.trim().length === 0}
        >
          Send
        </button>
      </div>
    </div>
  );
}
