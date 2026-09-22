"use client";

import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

function ago(ts?: number): string {
  if (!ts) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/**
 * Where Agent P's commands run: a throwaway cloud box, or this person's own
 * machine.
 *
 * The choice is a real one, so the page says what each side costs rather than
 * presenting two equivalent options.
 */
export function Computer({ dashboardKey }: { dashboardKey: string }) {
  const compute = useQuery(api.dashboard.getCompute, { key: dashboardKey });
  const setTarget = useMutation(api.dashboard.setComputeTarget);
  const revoke = useMutation(api.dashboard.revokeRunner);

  if (compute === undefined) return <div className="panel empty">Loading.</div>;

  const online = compute.runners.filter((r) => r.online);

  return (
    <>
      <div className="panel">
        <h3>Where commands run</h3>
        <p className="hint">
          Agent P only. Perry mode cannot run anything either way.
        </p>

        <div style={{ display: "grid", gap: 10 }}>
          <label
            className="item"
            style={{ display: "flex", gap: 12, cursor: "pointer", borderTop: "none" }}
          >
            <input
              type="radio"
              name="target"
              style={{ width: "auto", marginTop: 4 }}
              checked={compute.target === "sandbox"}
              onChange={() => void setTarget({ key: dashboardKey, target: "sandbox" })}
            />
            <span>
              <strong>Cloud sandbox</strong>
              <div className="item-meta">
                A Linux box that exists only for this install. A bad command
                destroys a container and nothing of yours is in it.
                {compute.sandboxConfigured
                  ? " Configured."
                  : " Needs DAYTONA_API_KEY."}
              </div>
            </span>
          </label>

          <label
            className="item"
            style={{ display: "flex", gap: 12, cursor: "pointer" }}
          >
            <input
              type="radio"
              name="target"
              style={{ width: "auto", marginTop: 4 }}
              checked={compute.target === "local"}
              onChange={() => void setTarget({ key: dashboardKey, target: "local" })}
            />
            <span>
              <strong>This machine</strong>
              <div className="item-meta">
                Your own files, through a runner you start and can stop. A bad
                command destroys your work. In exchange it can touch the things
                you actually care about.
                {online.length === 0 && compute.target === "local"
                  ? " Nothing is connected right now."
                  : ""}
              </div>
            </span>
          </label>
        </div>
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Connected machines</h3>
          <span className="badge">{online.length} online</span>
        </div>
        <p className="hint">
          Each one dials out and holds the connection. Nothing listens on a port,
          so no machine here is reachable from the internet.
        </p>

        {compute.runners.length === 0 && (
          <div className="empty">
            None. Run <code>npm run connect</code> on the machine you want.
          </div>
        )}

        {compute.runners.map((runner) => (
          <div className="item" key={runner.id}>
            <div className="row" style={{ justifyContent: "space-between", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{runner.name}</strong>
                {runner.autoApprove && (
                  <span className="badge" style={{ marginLeft: 8 }}>
                    auto-approve
                  </span>
                )}
                <div className="item-meta" style={{ overflowWrap: "anywhere" }}>
                  {runner.platform ?? "unknown"}
                  {runner.workdir ? ` · ${runner.workdir}` : ""}
                </div>
                <div className="item-meta">seen {ago(runner.lastSeenAt)}</div>
              </div>

              <div style={{ textAlign: "right" }}>
                <span
                  className={
                    runner.revoked ? "badge err" : runner.online ? "badge on" : "badge"
                  }
                >
                  {runner.revoked ? "revoked" : runner.online ? "online" : "offline"}
                </span>
                {!runner.revoked && (
                  <div style={{ marginTop: 8 }}>
                    <button
                      className="ghost danger"
                      onClick={() =>
                        void revoke({ key: dashboardKey, runnerId: runner.id })
                      }
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Recent commands</h3>
          <span className="badge">{compute.commands.length}</span>
        </div>
        <p className="hint">Everything sent to a connected machine.</p>

        {compute.commands.length === 0 && <div className="empty">Nothing yet.</div>}

        {compute.commands.map((command) => (
          <div className="item" key={command.id}>
            <div className="row" style={{ justifyContent: "space-between", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <code style={{ overflowWrap: "anywhere" }}>
                  {command.command ?? `${command.kind} ${command.path ?? ""}`}
                </code>
                <div className="item-meta">
                  {ago(command.createdAt)}
                  {typeof command.exitCode === "number"
                    ? ` · exit ${command.exitCode}`
                    : ""}
                </div>
                {command.error && (
                  <div className="item-meta" style={{ color: "var(--warn)" }}>
                    {command.error}
                  </div>
                )}
              </div>
              <span
                className={
                  command.status === "done"
                    ? "badge"
                    : command.status === "denied"
                      ? "badge"
                      : "badge err"
                }
              >
                {command.status}
              </span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
