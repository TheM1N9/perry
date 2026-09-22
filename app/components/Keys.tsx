"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";

/**
 * Service keys, editable here instead of in a terminal.
 *
 * A key entered here is write-only: it goes to the database and nothing ever
 * reads one back to this page. You see whether a key is set, where it came
 * from, and its last four characters. Enough to tell two keys apart, not
 * enough to use one.
 */
export function Keys({ dashboardKey }: { dashboardKey: string }) {
  const keys = useQuery(api.dashboard.getKeys, { key: dashboardKey });
  const setKey = useMutation(api.dashboard.setKey);
  const clearKey = useMutation(api.dashboard.clearKey);
  const registerWebhook = useAction(api.dashboard.registerWebhook);

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (keys === undefined) return <div className="panel empty">Loading.</div>;

  const save = async (name: string) => {
    const value = (drafts[name] ?? "").trim();
    if (value.length === 0) return;

    setSaving(name);
    setNotice(null);
    try {
      await setKey({ key: dashboardKey, name, value });
      setDrafts((current) => ({ ...current, [name]: "" }));
      setNotice(
        name.startsWith("TELEGRAM")
          ? `Saved. Telegram keys changed, so press Re-register below.`
          : "Saved. It takes effect on the next turn.",
      );
    } finally {
      setSaving(null);
    }
  };

  const reregister = async () => {
    setSaving("webhook");
    try {
      const result = await registerWebhook({ key: dashboardKey });
      setNotice(
        result.ok
          ? `Telegram now points here${result.bot ? `, as @${result.bot}` : ""}.`
          : `Could not register: ${result.error}`,
      );
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <div className="panel">
        <h3>Keys</h3>
        <p className="hint">
          Saved to your deployment, never shown again. These override anything
          set with <code>pnpm exec convex env set</code>, and clearing one falls back
          to the environment variable if there is one.
        </p>
        {notice && (
          <p className="hint" style={{ color: "var(--accent)" }}>
            {notice}
          </p>
        )}
      </div>

      {keys.map((entry) => (
        <div className="panel" key={entry.name}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3>{entry.label}</h3>
            <span className={entry.set ? "badge on" : "badge"}>
              {entry.set ? `set ${entry.preview}` : "not set"}
            </span>
          </div>
          <p className="hint">{entry.hint}</p>

          <div className="composer">
            <input
              type="password"
              autoComplete="off"
              placeholder={entry.set ? "Replace it" : "Paste it"}
              value={drafts[entry.name] ?? ""}
              onChange={(e) =>
                setDrafts((current) => ({
                  ...current,
                  [entry.name]: e.target.value,
                }))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") void save(entry.name);
              }}
            />
            <button
              className="primary"
              disabled={
                (drafts[entry.name] ?? "").trim().length === 0 ||
                saving === entry.name
              }
              onClick={() => void save(entry.name)}
            >
              {saving === entry.name ? "Saving" : "Save"}
            </button>
          </div>

          <div className="item-meta" style={{ marginTop: 8 }}>
            {entry.source === "dashboard" && "Set from here."}
            {entry.source === "environment" &&
              "Coming from an environment variable. Saving here overrides it."}
            {entry.source === "none" && "Nothing set."}
            {entry.source === "dashboard" && (
              <button
                className="ghost danger"
                style={{ marginLeft: 10 }}
                onClick={() => void clearKey({ key: dashboardKey, name: entry.name })}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      ))}

      <div className="panel">
        <h3>Telegram webhook</h3>
        <p className="hint">
          Points Telegram at this deployment. Run it after changing the bot
          token or the webhook secret, or the bot goes quiet without saying why.
        </p>
        <button
          disabled={saving === "webhook"}
          onClick={() => void reregister()}
        >
          {saving === "webhook" ? "Registering" : "Re-register"}
        </button>
      </div>

      <div className="panel">
        <h3>The one key that stays in a terminal</h3>
        <p className="hint">
          The dashboard key itself, <code>DASHBOARD_KEY</code>, is what guards
          this page, so it cannot be edited from behind it. Change it with{" "}
          <code>pnpm exec convex env set DASHBOARD_KEY</code>. That also makes a
          lockout recoverable rather than permanent.
        </p>
      </div>
    </>
  );
}
