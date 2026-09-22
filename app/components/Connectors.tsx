"use client";

import { useAction } from "convex/react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/convex/_generated/api";

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

/**
 * Connect an account here and Agent P can use it on the next turn.
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
  const [busy, setBusy] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [query, setQuery] = useState("");
  const [actions, setActions] = useState<FoundAction[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await getConnectors({ key: dashboardKey }));
    } catch (error) {
      setState({
        configured: false,
        connectors: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [dashboardKey, getConnectors]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const connect = async (toolkit: string) => {
    const slug = toolkit.trim().toLowerCase();
    if (!slug) return;

    setBusy(slug);
    setNotice(null);
    try {
      const result = await connectToolkit({ key: dashboardKey, toolkit: slug });
      if (result.redirectUrl) {
        window.open(result.redirectUrl, "_blank", "noopener");
        setNotice(
          `Finish signing in to ${slug} in the tab that just opened, then press Refresh.`,
        );
      } else {
        setNotice(result.error ?? `Could not start a connection for ${slug}.`);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const look = async () => {
    if (query.trim().length < 2) return;
    setActions(null);
    const result = await searchActions({ key: dashboardKey, query: query.trim() });
    setActions(result.actions);
    if (result.error) setNotice(result.error);
  };

  if (state === null) return <div className="panel empty">Loading.</div>;

  if (!state.configured) {
    return (
      <div className="panel">
        <h3>Not set up</h3>
        <p className="hint">
          Composio holds the OAuth for your accounts so Perry never sees a
          token. Get a key at composio.dev, then run:
        </p>
        <pre style={{ fontSize: 12, color: "var(--dim)" }}>
          pnpm exec convex env set COMPOSIO_API_KEY &lt;key&gt;
        </pre>
        {state.error && <p className="hint">{state.error}</p>}
      </div>
    );
  }

  const connected = state.connectors.filter((c) => c.connected);

  return (
    <>
      <div className="panel">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h3>Connected</h3>
          <div className="row" style={{ gap: 8 }}>
            <span className="badge">{connected.length}</span>
            <button className="ghost" onClick={() => void refresh()}>
              Refresh
            </button>
          </div>
        </div>
        <p className="hint">
          Agent P can use these on the next turn. Perry mode can see the list
          but cannot use any of them.
        </p>

        {notice && (
          <p className="hint" style={{ color: "var(--warn)" }}>
            {notice}
          </p>
        )}
        {state.error && (
          <p className="hint" style={{ color: "var(--danger)" }}>
            {state.error}
          </p>
        )}

        {connected.length === 0 && (
          <div className="empty">Nothing connected yet.</div>
        )}

        {connected.map((connector) => (
          <div className="item" key={connector.slug}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <strong>{connector.name}</strong>
                <div className="item-meta">{connector.slug}</div>
              </div>
              <span className="badge on">{connector.status ?? "active"}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <h3>Connect an account</h3>
        <p className="hint">
          Opens the provider's own sign-in. The token stays with Composio.
        </p>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 14,
          }}
        >
          {SUGGESTED.filter(
            (s) => !connected.some((c) => c.slug === s.slug),
          ).map((suggestion) => (
            <button
              key={suggestion.slug}
              disabled={busy !== null}
              onClick={() => void connect(suggestion.slug)}
            >
              {busy === suggestion.slug ? "Opening" : suggestion.name}
            </button>
          ))}
        </div>

        <div className="composer">
          <input
            value={custom}
            placeholder="Any other toolkit slug, e.g. hubspot"
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void connect(custom);
            }}
          />
          <button
            className="primary"
            disabled={custom.trim().length === 0 || busy !== null}
            onClick={() => void connect(custom)}
          >
            Connect
          </button>
        </div>
      </div>

      <div className="panel">
        <h3>What can it actually do</h3>
        <p className="hint">
          The same lookup Agent P runs before acting. Useful for checking a
          connection really works.
        </p>

        <div className="composer">
          <input
            value={query}
            placeholder="create a calendar event"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void look();
            }}
          />
          <button
            disabled={query.trim().length < 2}
            onClick={() => void look()}
          >
            Look up
          </button>
        </div>

        {actions?.length === 0 && (
          <div className="empty">Nothing matched.</div>
        )}
        {actions?.map((action) => (
          <div className="item" key={action.slug}>
            <code>{action.slug}</code>
            {action.description && (
              <div className="item-meta">{action.description}</div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
