"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const KIND = { command: "run", file: "change files", write: "write a file" } as const;

/**
 * What a runner is waiting to be allowed to do on the owner's machine. The
 * runner asks in its terminal and on Telegram too; whichever is answered
 * first wins.
 */
export function Approvals({ dashboardKey }: { dashboardKey: string }) {
  const pending = useQuery(api.approvals.pending, { key: dashboardKey });
  const decide = useMutation(api.approvals.decide);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState("");
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const answer = (id: Id<"approvals">, approved: boolean, always = false) =>
    void decide({ key: dashboardKey, id, approved, always })
      .then((applied) => setError(applied ? "" : "That request was already answered or has expired."))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));

  const live = (pending ?? []).filter((item) => item.expiresAt > now);
  if (!live.length && !error) return null;
  return <div className="approvals" role="region" aria-label="Waiting for your approval">
    {live.map((item) => <div className="approval" key={item.id}>
      <div className="approval-text">
        <div className="approval-head">{item.runner} wants to {KIND[item.kind]}{item.chat ? <span> · {item.chat.title}</span> : null}</div>
        <code className="approval-what">{item.title}</code>
        {item.cwd && <div className="approval-meta">in {item.cwd}</div>}
        {item.detail && <div className="approval-meta">{item.detail}</div>}
        {item.review && <div className="approval-meta approval-review">Reviewer: {item.review.verdict}. {item.review.reason}</div>}
        {item.alwaysAllow && <div className="approval-meta">Always allow saves a rule for {item.alwaysAllow}.</div>}
      </div>
      <div className="approval-actions">
        <button className="approval-decline" onClick={() => answer(item.id, false)}>Decline</button>
        {item.alwaysAllow && <button className="approval-decline approval-always" onClick={() => answer(item.id, true, true)}>Always allow</button>}
        <button className="approval-approve" onClick={() => answer(item.id, true)}>Approve</button>
      </div>
    </div>)}
    {error && <div className="approval-meta" role="alert">{error}</div>}
  </div>;
}
