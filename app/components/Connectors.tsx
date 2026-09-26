"use client";

import { useAction } from "@/client/react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "@/convex/_generated/api";
import { Command, Empty, Icon, Loading, Notice, Section, Spinner, Status, errorText, type Tone } from "./ui";

type Connector = {
  slug: string;
  name: string;
  connected: boolean;
  status?: string;
  needsAuth: boolean;
};

type FoundAction = {
  slug: string;
  description?: string;
  toolkit?: string;
};

/** The ones people actually want first. Anything else can be typed in. */
const SUGGESTED = [
  { slug: "googlecalendar", name: "Google Calendar" },
  { slug: "gmail", name: "Gmail" },
  { slug: "notion", name: "Notion" },
  { slug: "github", name: "GitHub" },
  { slug: "slack", name: "Slack" },
  { slug: "linear", name: "Linear" },
  { slug: "googledrive", name: "Google Drive" },
  { slug: "googlesheets", name: "Google Sheets" },
];

function connectionStatus(status?: string): { tone: Tone; label: string } {
  const value = (status ?? "active").toLowerCase();
  if (value === "active") return { tone: "success", label: "Connected" };
  if (value === "initiated" || value === "initializing" || value === "pending") return { tone: "info", label: "Finishing sign-in" };
  if (value === "expired") return { tone: "warning", label: "Expired" };
  if (value === "failed" || value === "error") return { tone: "danger", label: "Failed" };
  return { tone: "neutral", label: value.charAt(0).toUpperCase() + value.slice(1) };
}

/**
 * Connect an account here and Perry can use it on the next turn.
 *
 * Nothing about the agent changes when you do. It looks up what is connected
 * at the moment it needs to act, so this page is the only place that decides
 * what Perry can reach.
 */
export function Connectors({ dashboardKey }: { dashboardKey: string }) {
  const getConnectors = useAction(api.dashboard.getConnectors);
  const connectToolkit = useAction(api.dashboard.connectToolkit);
  const searchActions = useAction(api.dashboard.searchActions);

  const [state, setState] = useState<{
    configured: boolean;
    connectors: Connector[];
    error?: string;
  } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [query, setQuery] = useState("");
  const [looking, setLooking] = useState(false);
  const [actions, setActions] = useState<FoundAction[] | null>(null);
  const [lookupError, setLookupError] = useState("");
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null);
  /** The toolkit Composio just sent you back from, read off the callback URL. */
  const [returned, setReturned] = useState<{ slug: string; status: string | null } | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setState(await getConnectors({ key: dashboardKey }));
    } catch (error) {
      setState((current) => ({ configured: current?.configured ?? false, connectors: current?.connectors ?? [], error: errorText(error) }));
    } finally {
      setRefreshing(false);
    }
  }, [dashboardKey, getConnectors]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const slug = params.get("connected");
    if (!slug) return;
    setReturned({ slug, status: params.get("status") });
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  useEffect(() => {
    if (!returned || !state) return;
    const found = state.connectors.find((item) => item.slug === returned.slug && item.connected);
    const failed = returned.status !== null && returned.status.toLowerCase() !== "success";
    if (found) setNotice({ tone: "success", text: `${found.name} is connected. Perry can use it from the next message.` });
    else if (failed) setNotice({ tone: "danger", text: `Signing in to ${returned.slug} didn't finish. Try connecting it again.` });
    else setNotice({ tone: "info", text: `${returned.slug} isn't showing as connected yet. Refresh in a moment.` });
    setReturned(null);
  }, [returned, state]);

  const connect = async (toolkit: string) => {
    const slug = toolkit.trim().toLowerCase();
    if (!slug || busy) return;

    setBusy(slug);
    setNotice(null);
    try {
      const callbackUrl = `${window.location.origin}${window.location.pathname}?connected=${encodeURIComponent(slug)}`;
      const result = await connectToolkit({ key: dashboardKey, toolkit: slug, callbackUrl });
      if (result.redirectUrl) {
        // Same tab, so Composio can send you back here when sign-in ends.
        window.location.assign(result.redirectUrl);
        return;
      }
      setNotice({ tone: "danger", text: result.error ?? `Couldn't start a connection for “${slug}”. Check the toolkit name and try again.` });
    } catch (error) {
      setNotice({ tone: "danger", text: errorText(error) });
    }
    setBusy(null);
  };

  const look = async (event: FormEvent) => {
    event.preventDefault();
    if (query.trim().length < 2 || looking) return;
    setLooking(true);
    setLookupError("");
    try {
      const result = await searchActions({ key: dashboardKey, query: query.trim() });
      setActions(result.actions);
      if (result.error) setLookupError(result.error);
    } catch (error) {
      setActions(null);
      setLookupError(errorText(error));
    } finally {
      setLooking(false);
    }
  };

  if (state === null) return <Section title="Connected accounts"><Loading /></Section>;

  if (!state.configured) {
    return (
      <Section title="Connect your accounts" description="Composio holds the sign-ins for your accounts, so Perry never sees a password or token.">
        <div className="section-pad" style={{ display: "grid", gap: 12 }}>
          <ol className="steps" style={{ margin: 0 }}>
            <li><span className="step-mark" aria-hidden="true" />Create a Composio account and copy an API key from composio.dev.</li>
            <li><span className="step-mark" aria-hidden="true" />Add it on the Keys page, or run this in the project folder:</li>
          </ol>
          <Command>pnpm exec convex env set COMPOSIO_API_KEY your-key</Command>
          {state.error && <Notice tone="danger" title="Couldn't reach Composio" details={state.error} />}
          <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? <Spinner /> : <Icon name="refresh" size={14} />}Check again</button></div>
        </div>
      </Section>
    );
  }

  const connected = state.connectors.filter((c) => c.connected);
  const suggestions = SUGGESTED.filter((s) => !connected.some((c) => c.slug === s.slug));

  return (
    <>
      {notice && <Notice tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Notice>}
      {state.error && <Notice tone="danger" title="Couldn't load every connection" details={state.error} />}

      <Section title="Connected accounts" count={connected.length}
        description="Perry looks up what it can do with these at the moment it needs to act."
        actions={<button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()} disabled={refreshing} aria-busy={refreshing || undefined}>{refreshing ? <Spinner /> : <Icon name="refresh" size={14} />}Refresh</button>}>
        {connected.length === 0 && <Empty icon="plug" title="No accounts connected">Connect one below. Sign-in happens on the provider&apos;s own page.</Empty>}
        {connected.map((connector) => {
          const status = connectionStatus(connector.status);
          return <div className="item" key={connector.slug}>
            <div className="item-main">
              <div className="item-title">{connector.name}</div>
              <div className="item-meta"><span className="mono" style={{ fontSize: 12 }}>{connector.slug}</span></div>
            </div>
            <div className="item-side">
              <Status tone={status.tone}>{status.label}</Status>
              {status.tone !== "success" && <button type="button" className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void connect(connector.slug)}>{busy === connector.slug && <Spinner />}Reconnect</button>}
            </div>
          </div>;
        })}
      </Section>

      <Section title="Connect an account" description="Takes you to the provider's own sign-in, then back here. The token stays with Composio.">
        <div className="section-pad" style={{ display: "grid", gap: 16 }}>
          {suggestions.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {suggestions.map((suggestion) => (
              <button type="button" key={suggestion.slug} className="btn btn-secondary btn-sm" disabled={busy !== null} aria-busy={busy === suggestion.slug || undefined} onClick={() => void connect(suggestion.slug)}>
                {busy === suggestion.slug ? <Spinner /> : <Icon name="plus" size={13} />}{suggestion.name}
              </button>
            ))}
          </div>}
          <form className="field" style={{ margin: 0 }} onSubmit={(event) => { event.preventDefault(); void connect(custom); }}>
            <label htmlFor="custom-toolkit">Another service</label>
            <div className="inline-form">
              <input id="custom-toolkit" className="input" value={custom} placeholder="Toolkit name, e.g. hubspot…" autoComplete="off" spellCheck={false} onChange={(e) => setCustom(e.target.value.replace(/\s+/g, ""))} />
              <button type="submit" className="btn btn-primary btn-md" disabled={custom.trim().length === 0 || busy !== null}>{busy === custom.trim().toLowerCase() && <Spinner />}Connect</button>
            </div>
            <p className="field-hint">Use the toolkit&apos;s name from Composio&apos;s catalog: lowercase, no spaces.</p>
          </form>
        </div>
      </Section>

      <Section title="Test what Perry can do" description="Runs the same lookup Perry does before acting. Useful for checking a connection really works.">
        <div className="section-pad" style={{ display: "grid", gap: 12 }}>
          <form className="inline-form" onSubmit={(event) => void look(event)}>
            <label htmlFor="action-search" className="sr-only">Describe an action</label>
            <input id="action-search" className="input" value={query} placeholder="Describe an action, e.g. create a calendar event…" autoComplete="off" onChange={(e) => setQuery(e.target.value)} />
            <button type="submit" className="btn btn-secondary btn-md" disabled={query.trim().length < 2 || looking}>{looking && <Spinner />}{looking ? "Looking…" : "Look up"}</button>
          </form>
          {lookupError && <Notice tone="danger">{lookupError}</Notice>}
          {actions?.length === 0 && !lookupError && <p className="field-hint" role="status">No actions match. Try different words, or connect the service first.</p>}
          {actions && actions.length > 0 && <div className="section-body" role="status">
            <p className="result-count" style={{ padding: "10px 16px 0", margin: 0 }}>{actions.length} {actions.length === 1 ? "action" : "actions"} found</p>
            {actions.map((action) => (
              <div className="item" key={action.slug}>
                <div className="item-main">
                  <div className="item-title"><code className="mono" style={{ fontSize: 12.5 }}>{action.slug}</code>{action.toolkit && <span className="tag">{action.toolkit}</span>}</div>
                  {action.description && <div className="item-text">{action.description}</div>}
                </div>
              </div>
            ))}
          </div>}
        </div>
      </Section>
    </>
  );
}
