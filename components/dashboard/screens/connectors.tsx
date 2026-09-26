"use client";

import Link from "next/link";
import { PlusIcon, RefreshCwIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useAction } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { errorText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState, List, ListSkeleton, Page, Section, StatusBadge, type Tone } from "../common";

type Connector = { slug: string; name: string; connected: boolean; status?: string; needsAuth: boolean };
type FoundAction = { slug: string; description?: string; toolkit?: string };

/** The ones people want first. Anything else can be typed in. */
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
 * Accounts Perry can use for you. It looks up what is connected at the moment
 * it needs to act, so this page alone decides what it can reach.
 */
export function Connectors() {
  const { dashboardKey } = useSession();
  const getConnectors = useAction(api.dashboard.getConnectors);
  const connectToolkit = useAction(api.dashboard.connectToolkit);
  const [state, setState] = useState<{ configured: boolean; connectors: Connector[]; error?: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  /** The toolkit Composio just sent you back from, read off the callback address. */
  const [returned, setReturned] = useState<{ slug: string; status: string | null } | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setState(await getConnectors({ key: dashboardKey }));
    } catch (cause) {
      setState((current) => ({ configured: current?.configured ?? false, connectors: current?.connectors ?? [], error: errorText(cause) }));
    } finally {
      setRefreshing(false);
    }
  }, [dashboardKey, getConnectors]);
  useEffect(() => { void refresh(); }, [refresh]);

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
    if (found) toast.success(`${found.name} is connected. Perry can use it from the next message.`);
    else if (failed) toast.error(`Signing in to ${returned.slug} didn't finish. Try connecting it again.`);
    else toast.info(`${returned.slug} isn't showing as connected yet. Refresh in a moment.`);
    setReturned(null);
  }, [returned, state]);

  const connect = async (toolkit: string) => {
    const slug = toolkit.trim().toLowerCase();
    if (!slug || busy) return;
    setBusy(slug);
    try {
      const callbackUrl = `${window.location.origin}${window.location.pathname}?connected=${encodeURIComponent(slug)}`;
      const result = await connectToolkit({ key: dashboardKey, toolkit: slug, callbackUrl });
      // Same tab, so Composio can send you back here when sign-in ends.
      if (result.redirectUrl) return window.location.assign(result.redirectUrl);
      toast.error(result.error ?? `Couldn't start a connection for “${slug}”. Check the name and try again.`);
    } catch (cause) {
      toast.error(errorText(cause));
    }
    setBusy(null);
  };

  const refreshButton = (
    <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing} aria-busy={refreshing || undefined}>
      {refreshing ? <Spinner /> : <RefreshCwIcon />}Refresh
    </Button>
  );

  if (state === null) return <Page title="Connectors"><ListSkeleton /></Page>;

  if (!state.configured) {
    return (
      <Page title="Connectors" description="Accounts Perry can use for you: your calendar, email, notes and more.">
        <div className="rounded-xl border bg-card p-6">
          <h2 className="font-semibold">Connect through Composio</h2>
          <p className="mt-1 text-sm text-pretty text-muted-foreground">Composio holds the sign-ins, so Perry never sees a password or token.</p>
          <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm">
            <li>Create a Composio account and copy an API key from <a href="https://composio.dev" target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline-offset-2 hover:underline">composio.dev</a>.</li>
            <li>Paste it into <Link href="/settings?tab=keys" className="font-medium text-primary underline-offset-2 hover:underline">Settings › Keys</Link>, as the Composio key.</li>
          </ol>
          {state.error && <Alert variant="destructive" className="mt-4"><TriangleAlertIcon /><AlertTitle>Couldn&apos;t reach Composio</AlertTitle><AlertDescription>{state.error}</AlertDescription></Alert>}
          <div className="mt-5">{refreshButton}</div>
        </div>
      </Page>
    );
  }

  const connected = state.connectors.filter((item) => item.connected);
  const suggestions = SUGGESTED.filter((item) => !connected.some((found) => found.slug === item.slug));

  return (
    <Page title="Connectors" description="Accounts Perry can use for you. It checks what's connected each time it needs to act." actions={refreshButton}>
      {state.error && <Alert variant="destructive" className="mb-6"><TriangleAlertIcon /><AlertTitle>Couldn&apos;t load every connection</AlertTitle><AlertDescription>{state.error}</AlertDescription></Alert>}

      <Section title="Connected">
        {connected.length === 0
          ? <EmptyState title="No accounts connected">Pick one below. Sign-in happens on the provider&apos;s own page.</EmptyState>
          : (
            <List label="Connected accounts">
              {connected.map((connector) => {
                const status = connectionStatus(connector.status);
                return (
                  <li key={connector.slug} className="flex items-center gap-4 px-4 py-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-sm font-semibold uppercase" aria-hidden>{connector.name.charAt(0)}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{connector.name}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">{connector.slug}</p>
                    </div>
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                    {status.tone !== "success" && (
                      <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void connect(connector.slug)}>{busy === connector.slug && <Spinner />}Reconnect</Button>
                    )}
                  </li>
                );
              })}
            </List>
          )}
      </Section>

      <Section title="Add an account" description="You sign in on the provider's page, then come back here. The token stays with Composio.">
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {suggestions.map((item) => (
              <Button key={item.slug} variant="outline" className="rounded-full" disabled={busy !== null} aria-busy={busy === item.slug || undefined} onClick={() => void connect(item.slug)}>
                {busy === item.slug ? <Spinner /> : <PlusIcon />}{item.name}
              </Button>
            ))}
          </div>
        )}
        <form className="mt-5 max-w-md" onSubmit={(event) => { event.preventDefault(); void connect(custom); }}>
          <Field>
            <FieldLabel htmlFor="custom-toolkit">Another service</FieldLabel>
            <div className="flex gap-2">
              <Input id="custom-toolkit" value={custom} placeholder="hubspot" autoComplete="off" spellCheck={false} className="font-mono" onChange={(event) => setCustom(event.target.value.replace(/\s+/g, ""))} />
              <Button type="submit" disabled={!custom.trim() || busy !== null}>{busy === custom.trim().toLowerCase() && <Spinner />}Connect</Button>
            </div>
            <FieldDescription>Its name in Composio&apos;s catalog: lowercase, no spaces.</FieldDescription>
          </Field>
        </form>
      </Section>

      <ActionLookup />
    </Page>
  );
}

/** The lookup Perry runs before acting, to check a connection really works. */
function ActionLookup() {
  const { dashboardKey } = useSession();
  const searchActions = useAction(api.dashboard.searchActions);
  const [query, setQuery] = useState("");
  const [looking, setLooking] = useState(false);
  const [actions, setActions] = useState<FoundAction[] | null>(null);
  const [error, setError] = useState("");

  const look = async (event: FormEvent) => {
    event.preventDefault();
    if (query.trim().length < 2 || looking) return;
    setLooking(true);
    setError("");
    try {
      const result = await searchActions({ key: dashboardKey, query: query.trim() });
      setActions(result.actions);
      if (result.error) setError(result.error);
    } catch (cause) {
      setActions(null);
      setError(errorText(cause));
    } finally {
      setLooking(false);
    }
  };

  return (
    <Section title="Test what Perry can do" description="Describe an action to see which of your accounts' operations Perry would find for it.">
      <form className="flex gap-2" onSubmit={(event) => void look(event)}>
        <InputGroup>
          <InputGroupAddon><SearchIcon /></InputGroupAddon>
          <InputGroupInput aria-label="Describe an action" value={query} placeholder="Create a calendar event" autoComplete="off" onChange={(event) => setQuery(event.target.value)} />
        </InputGroup>
        <Button type="submit" variant="outline" disabled={query.trim().length < 2 || looking}>{looking && <Spinner />}Look up</Button>
      </form>
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      {actions?.length === 0 && !error && <p className="mt-3 text-sm text-muted-foreground" role="status">No actions match. Try other words, or connect the service first.</p>}
      {actions && actions.length > 0 && (
        <div className="mt-3" role="status">
          <p className="mb-2 text-sm text-muted-foreground">{actions.length} {actions.length === 1 ? "action" : "actions"} found</p>
          <List label="Actions found">
            {actions.map((action) => (
              <li key={action.slug} className="px-4 py-3">
                <p className="flex flex-wrap items-center gap-2"><code className="font-mono text-[13px] font-medium">{action.slug}</code>{action.toolkit && <StatusBadge>{action.toolkit}</StatusBadge>}</p>
                {action.description && <p className="mt-1 text-sm text-pretty text-muted-foreground">{action.description}</p>}
              </li>
            ))}
          </List>
        </div>
      )}
    </Section>
  );
}
