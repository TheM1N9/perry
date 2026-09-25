"use client";

import { useAction, useMutation, useQuery } from "@/client/react";
import { useState, type FormEvent } from "react";
import { api } from "@/convex/_generated/api";
import { ActionButton, Command, Loading, Notice, SecretInput, Section, Spinner, Status, errorText, useToast } from "./ui";

const SOURCE = {
  dashboard: "Saved here",
  environment: "From .env.local",
  none: "Not set",
} as const;

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
  const checkBot = useAction(api.dashboard.checkBot);
  const toast = useToast();

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [telegramChanged, setTelegramChanged] = useState(false);
  const [botCheck, setBotCheck] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  if (keys === undefined) return <Section title="Service keys"><Loading /></Section>;

  const save = async (event: FormEvent, name: string) => {
    event.preventDefault();
    const value = (drafts[name] ?? "").trim();
    if (value.length === 0 || saving) return;
    setSaving(name);
    setErrors((current) => ({ ...current, [name]: "" }));
    try {
      await setKey({ key: dashboardKey, name, value });
      setDrafts((current) => ({ ...current, [name]: "" }));
      if (name.startsWith("TELEGRAM")) setTelegramChanged(true);
      toast({ tone: "success", text: name.startsWith("TELEGRAM") ? "Saved. Perry listens to this bot within a few seconds." : "Saved. It takes effect on the next message." });
    } catch (cause) {
      setErrors((current) => ({ ...current, [name]: errorText(cause) }));
    } finally {
      setSaving(null);
    }
  };

  const check = async () => {
    setBotCheck(null);
    const result = await checkBot({ key: dashboardKey });
    if (result.ok) setTelegramChanged(false);
    setBotCheck(result.ok
      ? { tone: "success", text: `Perry is listening as @${result.bot}. Message it on Telegram.` }
      : { tone: "danger", text: `The bot isn't working: ${result.error}` });
  };

  return (
    <>
      <Section title="Service keys" description={<>Saved on this computer and never shown again. A key saved here overrides one in <code className="inline">.env.local</code>; clearing it falls back to that one, if there is one.</>}>
        {keys.map((entry) => {
          const id = `key-${entry.name}`;
          const error = errors[entry.name];
          return <form className="item" key={entry.name} onSubmit={(event) => void save(event, entry.name)} style={{ flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, width: "100%" }}>
              <div className="item-main">
                <label className="item-title" htmlFor={id}>{entry.label}</label>
                <div className="item-text">{entry.hint}</div>
              </div>
              {entry.set ? <Status tone="success"><span translate="no">Set{entry.preview ? ` · ${entry.preview}` : ""}</span></Status> : <Status>Not set</Status>}
            </div>
            <div className="inline-form" style={{ width: "100%" }}>
              <SecretInput id={id} name={entry.name} value={drafts[entry.name] ?? ""} placeholder={entry.set ? "Paste a new value to replace it…" : "Paste the key…"} invalid={Boolean(error)} describedBy={error ? `${id}-error` : undefined}
                onChange={(value) => { setDrafts((current) => ({ ...current, [entry.name]: value })); setErrors((current) => ({ ...current, [entry.name]: "" })); }} />
              <button type="submit" className="btn btn-primary btn-md" disabled={(drafts[entry.name] ?? "").trim().length === 0 || saving !== null} aria-busy={saving === entry.name || undefined}>
                {saving === entry.name && <Spinner />}{saving === entry.name ? "Saving…" : "Save"}
              </button>
            </div>
            {error && <p className="field-error" id={`${id}-error`} role="alert">{error}</p>}
            <div className="item-meta" style={{ width: "100%" }}>
              <span>{SOURCE[entry.source as keyof typeof SOURCE] ?? entry.source}{entry.source === "environment" ? ". Saving here overrides it." : ""}</span>
              {entry.source === "dashboard" && <span><ActionButton variant="ghost" className="btn-danger-ghost" action={() => clearKey({ key: dashboardKey, name: entry.name })} success={`${entry.label} cleared.`}
                confirm={{ title: `Clear the ${entry.label}?`, body: "Perry falls back to the environment variable if one is set. Otherwise anything that needs this key stops working.", confirmLabel: "Clear key" }}>Clear</ActionButton></span>}
            </div>
          </form>;
        })}
      </Section>

      <Section title="Telegram bot" description="Perry asks Telegram for new messages while it runs, so nothing here needs to be reachable from the internet. Check that the bot token works:"
        actions={<ActionButton variant={telegramChanged ? "primary" : "secondary"} icon="refresh" action={check} pendingLabel="Checking…">Check bot</ActionButton>}>
        {botCheck && <div className="section-pad"><Notice tone={botCheck.tone} onDismiss={() => setBotCheck(null)}>{botCheck.text}</Notice></div>}
      </Section>

      <Section title="Dashboard key" description="The key that guards this page can't be changed from behind it, which keeps a lockout recoverable. Change DASHBOARD_KEY in .env.local, in Perry's folder, then restart Perry:">
        <div className="section-pad"><Command>perry stop && perry start</Command></div>
      </Section>
    </>
  );
}
