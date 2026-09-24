"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Spinner, Status, errorText, useNow, useToast } from "./ui";

const KIND = { command: "run a command", file: "change files", write: "write a file" } as const;

function remaining(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * What a runner is waiting to be allowed to do on the owner's machine. The
 * runner asks in its terminal too; whichever is answered first wins.
 */
export function Approvals({ dashboardKey }: { dashboardKey: string }) {
  const pending = useQuery(api.approvals.pending, { key: dashboardKey });
  const decide = useMutation(api.approvals.decide);
  const toast = useToast();
  const now = useNow(1000);
  const [answering, setAnswering] = useState<{ id: Id<"approvals">; approved: boolean } | null>(null);

  const answer = async (id: Id<"approvals">, approved: boolean) => {
    setAnswering({ id, approved });
    try {
      const applied = await decide({ key: dashboardKey, id, approved });
      toast(applied
        ? { tone: "success", text: approved ? "Approved. The runner will go ahead." : "Declined. The runner won't do it." }
        : { tone: "danger", text: "That request was already answered or has expired." });
    } catch (cause) {
      toast({ tone: "danger", text: `Couldn't send your answer: ${errorText(cause)}` });
    } finally {
      setAnswering(null);
    }
  };

  const live = (pending ?? []).filter((item) => item.expiresAt > now);
  if (!live.length) return null;
  return <div className="approvals" role="region" aria-label="Waiting for your approval">
    {live.map((item) => {
      const busy = answering?.id === item.id;
      const left = item.expiresAt - now;
      return <div className="approval" key={item.id}>
        <div className="approval-text">
          <div className="approval-head">
            <Status tone="warning">Needs approval</Status>
            <span>{item.runner} wants to {KIND[item.kind]}</span>
            {item.chat && <span className="muted">in “{item.chat.title}”</span>}
          </div>
          <code className="approval-what">{item.title}</code>
          <div className="approval-meta">
            {item.cwd && <span>Folder: <span className="mono">{item.cwd}</span></span>}
            <span className="nums" aria-live="off">Expires in {remaining(left)}</span>
          </div>
          {item.detail && <div className="approval-meta">{item.detail}</div>}
        </div>
        <div className="approval-actions">
          <button type="button" className="btn btn-secondary btn-sm approval-decline" disabled={Boolean(answering)} onClick={() => void answer(item.id, false)}>
            {busy && !answering.approved && <Spinner />}Decline
          </button>
          <button type="button" className="btn btn-primary btn-sm approval-approve" disabled={Boolean(answering)} onClick={() => void answer(item.id, true)}>
            {busy && answering.approved && <Spinner />}Approve
          </button>
        </div>
      </div>;
    })}
  </div>;
}
