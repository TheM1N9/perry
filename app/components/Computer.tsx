"use client";

import { useMutation, useQuery } from "@/client/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import { Approvals } from "./Approvals";
import { Permissions } from "./Permissions";
import { ActionButton, Command, CopyButton, Empty, Icon, Loading, RelativeTime, Section, Spinner, Status, errorText, useToast, type Tone } from "./ui";

type Policy = "ask" | "review" | "trust";

/** A runner's approval policy, in the words the owner chooses by. */
const POLICIES: Array<{ value: Policy; label: string }> = [
  { value: "ask", label: "Ask me every time" },
  { value: "review", label: "Codex reviews; ask me about the risky ones" },
  { value: "trust", label: "Run without asking" },
];

const COMMAND_STATUS: Record<string, { tone: Tone; label: string }> = {
  queued: { tone: "neutral", label: "Queued" },
  running: { tone: "info", label: "Running" },
  done: { tone: "success", label: "Done" },
  denied: { tone: "warning", label: "Declined" },
  error: { tone: "danger", label: "Failed" },
};

/**
 * Where Perry's commands run: a throwaway cloud box, or this person's own
 * machine.
 *
 * The choice is a real one, so the page says what each side costs rather than
 * presenting two equivalent options.
 */
export function Computer({ dashboardKey }: { dashboardKey: string }) {
  const compute = useQuery(api.dashboard.getCompute, { key: dashboardKey });
  const setTarget = useMutation(api.dashboard.setComputeTarget);
  const revoke = useMutation(api.dashboard.revokeRunner);
  const setPolicy = useMutation(api.dashboard.setRunnerPolicy);
  const toast = useToast();
  const [saving, setSaving] = useState<"sandbox" | "local" | null>(null);
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

  const choose = async (target: "sandbox" | "local") => {
    setSaving(target);
    try {
      await setTarget({ key: dashboardKey, target });
      toast({ tone: "success", text: target === "sandbox" ? "Commands now run in the cloud sandbox." : "Commands now run on your machine." });
    } catch (cause) {
      toast({ tone: "danger", text: `Couldn't change where commands run: ${errorText(cause)}` });
    } finally {
      setSaving(null);
    }
  };

  if (compute === undefined) return <Section title="Where commands run"><Loading /></Section>;

  const online = compute.runners.filter((runner) => runner.online);
  const active = compute.runners.filter((runner) => !runner.revoked);
  const revoked = compute.runners.filter((runner) => runner.revoked);

  return (
    <>
      <Approvals dashboardKey={dashboardKey} />
      <Section plain title="Where commands run" description="Pick where Perry runs shell commands and edits files.">
        <div role="radiogroup" aria-label="Where commands run">
          <div className="choices">
            <label className="choice">
              <input type="radio" name="target" checked={compute.target === "sandbox"} disabled={saving !== null} onChange={() => void choose("sandbox")} />
              <span className="choice-title">Cloud sandbox {saving === "sandbox" && <Spinner size={12} />}</span>
              <span className="choice-text">A Linux box that exists only for this installation.</span>
              <ul className="choice-list">
                <li className="pro"><Icon name="check" size={13} />A bad command can only break a disposable container</li>
                <li className="con"><Icon name="alert" size={13} />Can&apos;t reach your own files or apps</li>
              </ul>
              <span className="choice-foot">{compute.sandboxConfigured ? <Status tone="success">Ready</Status> : <Status tone="warning">Needs DAYTONA_API_KEY</Status>}</span>
            </label>
            <label className="choice">
              <input type="radio" name="target" checked={compute.target === "local"} disabled={saving !== null} onChange={() => void choose("local")} />
              <span className="choice-title">Your machine {saving === "local" && <Spinner size={12} />}</span>
              <span className="choice-text">Your own files, through a runner you start and can stop.</span>
              <ul className="choice-list">
                <li className="pro"><Icon name="check" size={13} />Works with the things you actually care about</li>
                <li className="con"><Icon name="alert" size={13} />A bad command can damage your work</li>
              </ul>
              <span className="choice-foot">{online.length > 0 ? <Status tone="success">{online.length} online</Status> : <Status tone="warning">No machine online</Status>}</span>
            </label>
          </div>
        </div>
      </Section>

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

      <Section title="Recent commands" count={compute.commands.length} description="The last 20 things sent to a connected machine.">
        {compute.commands.length === 0 && <Empty icon="computer" title="No commands yet">Commands Perry runs on a connected machine will show up here.</Empty>}
        {compute.commands.map((command) => {
          const text = command.command ?? `${command.kind} ${command.path ?? ""}`.trim();
          const status = COMMAND_STATUS[command.status] ?? { tone: "neutral" as Tone, label: command.status };
          return <div className="item" key={command.id}>
            <div className="item-main">
              <div style={{ display: "flex", gap: 6, alignItems: "flex-start", minWidth: 0 }}>
                <code className="approval-what" style={{ flex: 1, maxHeight: 120 }}>{text}</code>
                <CopyButton value={text} iconOnly label="Copy command" />
              </div>
              <div className="item-meta">
                <RelativeTime at={command.createdAt} />
                {typeof command.exitCode === "number" && <span className="nums">Exit code {command.exitCode}</span>}
              </div>
              {command.error && <details className="disclosure"><summary>Error output</summary><pre className="activity-prompt-text">{command.error}</pre></details>}
            </div>
            <div className="item-side"><Status tone={status.tone} pulse={command.status === "running"}>{status.label}</Status></div>
          </div>;
        })}
      </Section>
    </>
  );
}
