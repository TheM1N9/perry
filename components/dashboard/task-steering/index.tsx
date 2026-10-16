"use client";

import { useId, useRef, useState } from "react";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const LABELS: Record<string, string> = {
  pending: "Accepted · waiting for engine acknowledgement",
  applied: "Delivered into the running turn",
  queued: "Accepted · queued for the next turn",
  running: "Follow-up turn running",
  finished: "Follow-up turn finished",
  stopped: "Delivery stopped",
  failed: "Follow-up turn failed",
  missing: "Delivery record unavailable",
};

/** Lives beside the plan so an agent's later set_plan cannot erase the owner's updates. */
export function TaskSteering({ task }: { task: Doc<"tasks"> }) {
  const { dashboardKey } = useSession();
  const inputId = useId();
  const send = useMutation(api.tasks.steerFromDashboard);
  const updates = useQuery(api.tasks.steeringFromDashboard, { key: dashboardKey, id: task._id });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ text: string; id: string } | null>(null);
  const busy = useRef(false);
  const canSteer = task.status === "running" && Boolean(task.conversationId && task.turns);

  return (
    <div className="mt-3 max-w-md space-y-2" data-task-steering>
      {updates && updates.length > 0 && <ol className="space-y-2 text-sm" aria-label="Owner updates">
        {updates.map((update) => <li key={update.requestId}>
          <p className="whitespace-pre-wrap">{update.text}</p>
          <p className="text-muted-foreground" role="status">{LABELS[update.state] ?? "Delivery status unavailable"}</p>
        </li>)}
      </ol>}
      {canSteer && <form className="space-y-2" onSubmit={async (event) => {
        event.preventDefault();
        const value = text.trim();
        if (!value || busy.current) return;
        // Retain the id after an ambiguous response; edits represent a different request.
        if (request.current?.text !== value) request.current = { text: value, id: crypto.randomUUID() };
        busy.current = true;
        setSending(true);
        setError("");
        try {
          await send({ key: dashboardKey, id: task._id, text: value, requestId: request.current.id });
          request.current = null;
          setText("");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "The update could not be sent. Retry it.");
        } finally {
          busy.current = false;
          setSending(false);
        }
      }}>
        <label htmlFor={inputId} className="block text-sm font-medium">Update instructions</label>
        <Input id={inputId} value={text} maxLength={4000} disabled={sending}
          aria-describedby={error ? `${inputId}-error` : undefined} aria-invalid={Boolean(error)}
          onChange={(event) => setText(event.target.value)} placeholder="What should Perry change as it works?" />
        {error && <p id={`${inputId}-error`} className="text-sm text-destructive" role="alert">{error}</p>}
        <Button size="sm" type="submit" disabled={sending || !text.trim()}>{sending ? "Sending…" : "Send update"}</Button>
      </form>}
    </div>
  );
}
