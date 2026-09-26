"use client";

import { useMutation, useQuery } from "@/client/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { Approvals } from "./Approvals";
import { Permissions } from "./Permissions";
import { ActionButton, Command, Empty, Loading, RelativeTime, Section, Spinner, Status, errorText, useToast, type Tone } from "./ui";

type Policy = "ask" | "review" | "trust";

/** A runner's approval policy, in the words the owner chooses by. */
const POLICIES: Array<{ value: Policy; label: string }> = [
  { value: "ask", label: "Ask me every time" },
  { value: "review", label: "Codex reviews; ask me about the risky ones" },
  { value: "trust", label: "Run without asking" },
];

/**
 * The machines Perry works on: each one runs Codex for Perry's turns, and asks
 * before it acts as its policy says. Requests waiting for an answer sit above
 * them, and the rules already saved below.
 */
export function Computer({ dashboardKey }: { dashboardKey: string }) {
  const compute = useQuery(api.dashboard.getCompute, { key: dashboardKey });
  const revoke = useMutation(api.dashboard.revokeRunner);
  const setPolicy = useMutation(api.dashboard.setRunnerPolicy);
  const toast = useToast();
  const [showRevoked, setShowRevoked] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState<string | null>(null);

  const choosePolicy = async (runnerId: string, name: string, policy: Policy) => {
    setSavingPolicy(runnerId);
    try {
      await setPolicy({ key: dashboardKey, runnerId, policy });
      toast({ tone: "success", text: `${name}: ${POLICIES.find((item) => item.value === policy)?.label}.` });
    } catch (cause) {
      toast({ tone: "danger", text: `Couldn't change how ${name} asks: ${errorText(cause)}` });
    } finally {
      setSavingPolicy(null);
    }
  };

  if (compute === undefined) return <Section title="Connected machines"><Loading /></Section>;

  const active = compute.runners.filter((runner) => !runner.revoked);
  const revoked = compute.runners.filter((runner) => runner.revoked);

  return (
    <>
      <Approvals dashboardKey={dashboardKey} />
      <Section title="Connected machines" count={active.length}
        description="Each runner dials out and holds the connection. Nothing listens on a port, so no machine here can be reached from the internet.">
        {compute.runners.length === 0 && <Empty icon="computer" title="No machines connected" action={<div style={{ width: "min(360px, 100%)" }}><Command>pnpm run connect</Command></div>}>
          Run this on the computer you want Perry to use. It stays connected while the terminal is open.
        </Empty>}
        {active.length === 0 && compute.runners.length > 0 && <Empty icon="computer" title="No machines connected" action={<div style={{ width: "min(360px, 100%)" }}><Command>pnpm run connect</Command></div>}>
          Every machine here was revoked. Run this on the computer you want Perry to use.
        </Empty>}
        {[...active, ...(showRevoked ? revoked : [])].map((runner) => {
          const state: { tone: Tone; label: string } = runner.revoked ? { tone: "danger", label: "Revoked" } : runner.online ? { tone: "success", label: "Online" } : { tone: "neutral", label: "Offline" };
          return <div className="item" key={runner.id}>
            <div className="item-main">
              <div className="item-title"><strong>{runner.name}</strong>{runner.policy === "trust" && !runner.revoked && <span className="tag" title="Runs commands without asking">Runs without asking</span>}</div>
              <div className="item-meta">
                <span>{runner.platform ?? "Unknown platform"}</span>
                {runner.workdir && <span className="mono" style={{ fontSize: 12 }}>{runner.workdir}</span>}
                <RelativeTime at={runner.lastSeenAt} prefix="Seen " />
              </div>
              {!runner.revoked && !runner.online && <div className="item-meta"><span>Start it again with <code className="inline">pnpm run connect</code> on that machine.</span></div>}
              {!runner.revoked && <div className="field" style={{ margin: "6px 0 0", maxWidth: 360 }}>
                <label htmlFor={`policy-${runner.id}`} className="field-hint">Before it acts {savingPolicy === runner.id && <Spinner size={11} />}</label>
                <select id={`policy-${runner.id}`} className="select runner-policy" value={runner.policy} disabled={savingPolicy === runner.id}
                  onChange={(event) => void choosePolicy(runner.id, runner.name, event.target.value as Policy)}>
                  {POLICIES.map((policy) => <option key={policy.value} value={policy.value}>{policy.label}</option>)}
                </select>
              </div>}
            </div>
            <div className="item-side">
              <Status tone={state.tone}>{state.label}</Status>
              {!runner.revoked && <ActionButton variant="ghost" className="btn-danger-ghost" action={() => revoke({ key: dashboardKey, runnerId: runner.id })} success={`${runner.name} can no longer run commands.`}
                confirm={{ title: `Revoke ${runner.name}?`, body: "Its next request will be refused and it stops getting work. To use this machine again, connect it again.", confirmLabel: "Revoke" }}>Revoke</ActionButton>}
            </div>
          </div>;
        })}
        {revoked.length > 0 && <div className="activity-more">
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={showRevoked} onClick={() => setShowRevoked(!showRevoked)}>
            {showRevoked ? "Hide revoked machines" : `Show ${revoked.length} revoked ${revoked.length === 1 ? "machine" : "machines"}`}
          </button>
        </div>}
      </Section>

      <Permissions dashboardKey={dashboardKey} telegram={compute.telegramApprovals} />
    </>
  );
}
