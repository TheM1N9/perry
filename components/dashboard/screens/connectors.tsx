"use client";

import Link from "next/link";
import { PlusIcon, RefreshCwIcon, SearchIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useAction } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { CatalogApp, ConnectedAccount } from "@/convex/composio";
import { errorText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { ActionButton, EmptyState, List, ListSkeleton, Page, Section, StatusBadge, type Tone } from "../common";

type FoundAction = { slug: string; description?: string; toolkit?: string };

/** The ones people reach for first, in this order; the rest are under All apps. */
const POPULAR = ["gmail", "googlecalendar", "slack", "notion", "googledrive", "googlesheets", "github", "outlook", "linear", "googledocs"];
/** All apps shows this many at a time; search finds the rest. */
const PAGE = 40;

function connectionStatus(status?: string): { tone: Tone; label: string } {
  const value = (status ?? "active").toLowerCase();
  if (value === "active") return { tone: "success", label: "Connected" };
  if (value === "initiated" || value === "initializing" || value === "pending") return { tone: "info", label: "Finishing sign-in" };
  if (value === "expired") return { tone: "warning", label: "Expired" };
  if (value === "failed" || value === "error") return { tone: "danger", label: "Failed" };
  if (value === "inactive") return { tone: "neutral", label: "Paused" };
  return { tone: "neutral", label: value.charAt(0).toUpperCase() + value.slice(1) };
}

const addedOn = (at?: string) => at ? `Added ${new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" })}` : "";

/** An app's logo from Composio, or its initial when there is none or it will not load. */
function AppLogo({ name, logo, className }: { name: string; logo?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={cn("grid size-10 shrink-0 place-items-center overflow-hidden rounded-full border bg-background", className)} aria-hidden>
      {logo && !failed
        // eslint-disable-next-line @next/next/no-img-element -- a remote logo per app, shown as is
        ? <img src={logo} alt="" width={22} height={22} loading="lazy" referrerPolicy="no-referrer" className="size-[22px] object-contain" onError={() => setFailed(true)} />
        : <span className="text-sm font-semibold uppercase">{name.charAt(0)}</span>}
    </span>
  );
}

/** One app in the catalogue: its logo, name and a line about it, and + to connect an account. */
function AppRow({ app, connected, busy, onConnect }: { app: CatalogApp; connected: number; busy: string | null; onConnect: (slug: string) => void }) {
  return (
    <li className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-muted/50">
      <AppLogo name={app.name} logo={app.logo} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-[15px] font-medium">
          {app.name}
          {connected > 0 && <span className="text-xs font-normal text-success">{connected === 1 ? "Connected" : `${connected} connected`}</span>}
        </p>
        {app.description && <p className="truncate text-sm text-muted-foreground" title={app.description}>{app.description}</p>}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label={connected ? `Connect another ${app.name} account` : `Connect ${app.name}`} title={connected ? "Connect another account" : "Connect"}
        disabled={busy !== null} aria-busy={busy === app.slug || undefined} onClick={() => onConnect(app.slug)}>
        {busy === app.slug ? <Spinner /> : <PlusIcon />}
      </Button>
    </li>
  );
}

/**
 * Accounts Perry can use for you. It looks up what is connected at the moment
 * it needs to act, so this page alone decides what it can reach.
 */
export function Connectors() {
  const { dashboardKey } = useSession();
  const getAccounts = useAction(api.dashboard.getConnectedAccounts);
  const getCatalog = useAction(api.dashboard.getCatalog);
  const connectToolkit = useAction(api.dashboard.connectToolkit);
  const disconnectAccount = useAction(api.dashboard.disconnectAccount);
  const [state, setState] = useState<{ configured: boolean; accounts: ConnectedAccount[]; error?: string } | null>(null);
  const [catalog, setCatalog] = useState<CatalogApp[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(PAGE);
  /** The toolkit Composio just sent you back from, read off the callback address. */
  const [returned, setReturned] = useState<{ slug: string; status: string | null } | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setState(await getAccounts({ key: dashboardKey }));
    } catch (cause) {
      setState((current) => ({ configured: current?.configured ?? false, accounts: current?.accounts ?? [], error: errorText(cause) }));
    } finally {
      setRefreshing(false);
    }
  }, [dashboardKey, getAccounts]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!state?.configured || catalog) return;
    void getCatalog({ key: dashboardKey }).then((result) => setCatalog(result.apps), () => setCatalog([]));
  }, [state?.configured, catalog, dashboardKey, getCatalog]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const slug = params.get("connected");
    if (!slug) return;
    setReturned({ slug, status: params.get("status") });
    window.history.replaceState(null, "", window.location.pathname);
  }, []);
  useEffect(() => {
    if (!returned || !state) return;
    const found = state.accounts.find((item) => item.toolkit === returned.slug && item.status === "ACTIVE");
    const failed = returned.status !== null && returned.status.toLowerCase() !== "success";
    if (found) toast.success(`${found.name}${found.account ? ` (${found.account})` : ""} is connected. Perry can use it from the next message.`);
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

  const term = search.trim().toLowerCase();
  const matches = useCallback((text?: string) => Boolean(text?.toLowerCase().includes(term)), [term]);
  const accounts = useMemo(() => (state?.accounts ?? []).filter((item) => !term || matches(item.name) || matches(item.account) || matches(item.toolkit)), [state, term, matches]);
  const found = useMemo(() => (catalog ?? []).filter((app) => !term || matches(app.name) || matches(app.slug) || matches(app.category) || matches(app.description)), [catalog, term, matches]);
  const connectedCount = (slug: string) => (state?.accounts ?? []).filter((item) => item.toolkit === slug && item.status === "ACTIVE").length;
  useEffect(() => setShown(PAGE), [term]);

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

  const searchBox = (
    <InputGroup className="h-9 w-full sm:w-72">
      <InputGroupAddon><SearchIcon /></InputGroupAddon>
      <InputGroupInput type="search" aria-label="Search apps" placeholder={catalog ? `Search ${Math.floor(catalog.length / 100) * 100}+ apps` : "Search apps"} value={search} autoComplete="off"
        onChange={(event) => setSearch(event.target.value)} />
      {search && <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setSearch("")}><XIcon /></InputGroupButton></InputGroupAddon>}
    </InputGroup>
  );
  const popular = POPULAR.map((slug) => catalog?.find((app) => app.slug === slug)).filter((app): app is CatalogApp => Boolean(app));
  const rest = term ? found : found.filter((app) => !POPULAR.includes(app.slug));

  return (
    <Page wide title="Connectors" description="Let Perry work across the apps you already use. It checks what's connected each time it acts." actions={<div className="flex items-center gap-2">{searchBox}{refreshButton}</div>}>
      {state.error && <Alert variant="destructive" className="mb-6"><TriangleAlertIcon /><AlertTitle>Couldn&apos;t load every connection</AlertTitle><AlertDescription>{state.error}</AlertDescription></Alert>}

      <Section title="Connected" description="Each account Perry can act on. The sign-in stays with Composio.">
        {state.accounts.length === 0
          ? <EmptyState title="No accounts connected">Pick an app below. Sign-in happens on the provider&apos;s own page.</EmptyState>
          : accounts.length === 0
            ? <p className="text-sm text-muted-foreground" role="status">No connected account matches &ldquo;{search.trim()}&rdquo;.</p>
            : (
              <List label="Connected accounts">
                {accounts.map((item) => {
                  const status = connectionStatus(item.status);
                  return (
                    <li key={item.id} className="flex items-center gap-4 px-4 py-3">
                      <AppLogo name={item.name} logo={item.logo} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{item.name}</p>
                        <p className="truncate text-sm text-muted-foreground" title={item.account ? `Signed in as ${item.account}` : undefined}>
                          {item.account ?? addedOn(item.createdAt)}
                        </p>
                      </div>
                      <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                      {status.tone !== "success" && (
                        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void connect(item.toolkit)}>{busy === item.toolkit && <Spinner />}Reconnect</Button>
                      )}
                      <ActionButton variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive"
                        action={async () => { const result = await disconnectAccount({ key: dashboardKey, accountId: item.id }); if (result.error) throw new Error(result.error); await refresh(); }}
                        success={`${item.name} disconnected.`}
                        confirm={{ title: `Disconnect ${item.name}?`, body: <>Perry can no longer use {item.account ? <strong>{item.account}</strong> : "this account"}. You can connect it again any time.</>, label: "Disconnect" }}>
                        Disconnect
                      </ActionButton>
                    </li>
                  );
                })}
              </List>
            )}
      </Section>

      {catalog === null ? <ListSkeleton /> : (
        <>
          {!term && popular.length > 0 && (
            <Section title="Popular">
              <ul aria-label="Popular apps" className="grid gap-1 sm:grid-cols-2">
                {popular.map((app) => <AppRow key={app.slug} app={app} connected={connectedCount(app.slug)} busy={busy} onConnect={(slug) => void connect(slug)} />)}
              </ul>
            </Section>
          )}
          <Section title={term ? `Apps matching “${search.trim()}”` : "All apps"} description={term ? `${rest.length} ${rest.length === 1 ? "app" : "apps"}` : undefined}>
            {rest.length === 0
              ? <EmptyState title="No app by that name" action={<Button variant="outline" size="sm" onClick={() => setSearch("")}>Clear search</Button>}>Try another word, like what it does: email, calendar, CRM.</EmptyState>
              : (
                <>
                  <ul aria-label={term ? "Matching apps" : "All apps"} className="grid gap-1 sm:grid-cols-2">
                    {rest.slice(0, shown).map((app) => <AppRow key={app.slug} app={app} connected={connectedCount(app.slug)} busy={busy} onConnect={(slug) => void connect(slug)} />)}
                  </ul>
                  {rest.length > shown && (
                    <div className="mt-4 flex justify-center">
                      <Button variant="outline" size="sm" onClick={() => setShown((count) => count + PAGE * 2)}>Show more ({rest.length - shown} left)</Button>
                    </div>
                  )}
                </>
              )}
          </Section>
        </>
      )}

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
