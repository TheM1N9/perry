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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

const addedOn = (at?: string, withTime = false) => at ? `Added ${new Date(at).toLocaleString(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" })}` : "Added earlier";

/** Which of one account's connections to keep using: a working one first, then the newest. */
const RANK: Record<string, number> = { ACTIVE: 0, INITIATED: 1, INITIALIZING: 1, INACTIVE: 2, EXPIRED: 3, FAILED: 4 };
const rank = (item: ConnectedAccount) => RANK[item.status.toUpperCase()] ?? 5;
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** One account at an app: the connection Perry uses, and any spares signed in to the same address. */
type Account = { main: ConnectedAccount; spares: ConnectedAccount[]; label: string };
/** One app and the accounts connected to it, with how many aren't working. */
type AppAccounts = { toolkit: string; name: string; logo?: string; accounts: Account[]; broken: number; finishing: number };

/**
 * Connections by app, then by account. Composio keeps a row per sign-in, so
 * signing in to the same address twice leaves two; they are one account here,
 * with the rest as spares. Without an address two connections can't be told
 * apart, so each stays its own account. Apps with something to fix come first.
 */
function byApp(connections: ConnectedAccount[]): AppAccounts[] {
  const apps = new Map<string, { name: string; logo?: string; accounts: Map<string, ConnectedAccount[]> }>();
  for (const item of connections) {
    const app = apps.get(item.toolkit) ?? { name: item.name, logo: item.logo, accounts: new Map() };
    const key = item.account ? item.account.toLowerCase() : `#${item.id}`;
    app.accounts.set(key, [...app.accounts.get(key) ?? [], item]);
    apps.set(item.toolkit, app);
  }
  return [...apps].map(([toolkit, app]) => {
    const accounts = [...app.accounts.values()].map((items) => {
      const [main, ...spares] = items.sort((a, b) => rank(a) - rank(b) || (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
      return { main, spares, label: main.account ?? addedOn(main.createdAt) };
    });
    // Two accounts known only by the day they were added: the time tells them apart.
    const same = accounts.filter((account) => !account.main.account && accounts.some((other) => other !== account && other.label === account.label));
    for (const account of same) account.label = addedOn(account.main.createdAt, true);
    accounts.sort((a, b) => Number(rank(b.main) > 0) - Number(rank(a.main) > 0) || a.label.localeCompare(b.label));
    const tones = accounts.map((account) => connectionStatus(account.main.status).tone);
    return {
      toolkit, name: app.name, logo: app.logo, accounts,
      broken: tones.filter((tone) => tone !== "success" && tone !== "info").length,
      finishing: tones.filter((tone) => tone === "info").length,
    };
  }).sort((a, b) => Number(b.broken + b.finishing > 0) - Number(a.broken + a.finishing > 0) || a.name.localeCompare(b.name));
}

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
function AppRow({ app, connected, busy, onConnect }: { app: CatalogApp; connected: number; busy: string | null; onConnect: (slug: string, from: string) => void }) {
  return (
    <li className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-muted/50">
      <AppLogo name={app.name} logo={app.logo} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-md font-medium">
          {app.name}
          {connected > 0 && <span className="text-xs font-normal text-success">{connected === 1 ? "Connected" : `${connected} connected`}</span>}
        </p>
        {app.description && <p className="truncate text-sm text-muted-foreground" title={app.description}>{app.description}</p>}
      </div>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={connected ? `Connect another ${app.name} account` : `Connect ${app.name}`}
          disabled={busy !== null} aria-busy={busy === `app:${app.slug}` || undefined} onClick={() => onConnect(app.slug, `app:${app.slug}`)} />}>
          {busy === `app:${app.slug}` ? <Spinner /> : <PlusIcon />}
        </TooltipTrigger>
        <TooltipContent>{connected ? "Connect another account" : "Connect"}</TooltipContent>
      </Tooltip>
    </li>
  );
}

/** A connection's state as words, said only when it isn't working: a healthy account needs no label. */
const TONE_TEXT: Record<Tone, string> = { neutral: "text-muted-foreground", success: "text-success", warning: "text-warning", danger: "text-destructive", info: "text-primary" };

/** An app you've connected, drawn like a catalogue row, with its accounts listed under its name. */
function AppGroup({ app, busy, onConnect, onRemove }: {
  app: AppAccounts; busy: string | null; onConnect: (slug: string, from: string) => void; onRemove: (items: ConnectedAccount[]) => Promise<void>;
}) {
  return (
    <li aria-label={app.name}>
      <div className="flex items-center gap-3 rounded-xl px-3 py-2.5">
        <AppLogo name={app.name} logo={app.logo} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-md font-medium">{app.name}</p>
          <p className="truncate text-sm text-muted-foreground">
            {plural(app.accounts.length, "account")}
            {app.broken > 0 && <span className="text-warning"> · {app.broken} {app.broken === 1 ? "needs" : "need"} reconnecting</span>}
            {app.finishing > 0 && <> · {app.finishing} finishing sign-in</>}
          </p>
        </div>
        <Button variant="ghost" size="sm" className="text-muted-foreground" aria-label={`Add another ${app.name} account`} disabled={busy !== null} aria-busy={busy === `add:${app.toolkit}` || undefined} onClick={() => onConnect(app.toolkit, `add:${app.toolkit}`)}>
          {busy === `add:${app.toolkit}` ? <Spinner /> : <PlusIcon />}<span className="hidden sm:inline">Add another account</span>
        </Button>
      </div>
      <ul aria-label={`${app.name} accounts`}>
        {app.accounts.map((account) => <AccountRow key={account.main.id} app={app} account={account} busy={busy} onConnect={onConnect} onRemove={onRemove} />)}
      </ul>
    </li>
  );
}

/** One account under its app, lined up with the app's name: who it is, and what to do when it isn't working. */
function AccountRow({ app, account, busy, onConnect, onRemove }: {
  app: AppAccounts; account: Account; busy: string | null; onConnect: (slug: string, from: string) => void; onRemove: (items: ConnectedAccount[]) => Promise<void>;
}) {
  const { main, spares, label } = account;
  const status = connectionStatus(main.status);
  const working = status.tone === "success";
  const who = main.account ? <strong>{main.account}</strong> : "this account";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-3 py-1.5 hover:bg-muted/50 sm:pl-16">
      <div className="min-w-0 flex-1 basis-48">
        <p className={cn("truncate", !main.account && "text-muted-foreground")} title={main.account ? `Signed in as ${main.account}` : undefined}>{label}</p>
        {spares.length > 0 && (
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            Connected {spares.length + 1} times
            <ActionButton variant="link" size="xs" className="h-auto px-0 text-muted-foreground underline underline-offset-2 hover:text-foreground"
              action={() => onRemove(spares)}
              success={`Removed ${plural(spares.length, "extra connection")}.`}
              confirm={{
                title: `Remove ${plural(spares.length, "extra connection")}?`,
                body: <>{who} was signed in to {app.name} more than once. Perry keeps the {working ? "working" : "newest"} connection and the {spares.length === 1 ? "other is" : `other ${spares.length} are`} removed.</>,
                label: "Remove extras",
              }}>
              Remove extras
            </ActionButton>
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {!working && <span className={cn("text-sm font-medium", TONE_TEXT[status.tone])}>{status.label}</span>}
        {!working && (
          <Button variant="outline" size="sm" disabled={busy !== null} aria-busy={busy === `account:${main.id}` || undefined} onClick={() => onConnect(app.toolkit, `account:${main.id}`)}>{busy === `account:${main.id}` && <Spinner />}Reconnect</Button>
        )}
        <ActionButton variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive"
          action={() => onRemove([main, ...spares])}
          success={`${main.account ? `${app.name} (${main.account})` : app.name} disconnected.`}
          confirm={{
            title: `Disconnect ${app.name}?`,
            body: <>Perry can no longer use {who}{spares.length > 0 ? `, and all ${spares.length + 1} of its connections are removed` : ""}. You can connect it again any time.</>,
            label: "Disconnect",
          }}>
          Disconnect
        </ActionButton>
      </div>
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
  /** The control that started a sign-in ("app:gmail", "add:gmail", "account:<id>"), so only it spins. */
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

  const connect = async (toolkit: string, from: string) => {
    const slug = toolkit.trim().toLowerCase();
    if (!slug || busy) return;
    setBusy(from);
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

  /** Disconnect connections at Composio, all of them even when one fails, then show what's left. */
  const remove = async (items: ConnectedAccount[]) => {
    const results = await Promise.all(items.map((item) => disconnectAccount({ key: dashboardKey, accountId: item.id }).catch((cause) => ({ error: errorText(cause) }))));
    await refresh();
    const failed = results.filter((result) => result.error);
    if (failed.length === 0) return;
    if (failed.length === items.length) throw new Error(failed[0].error);
    throw new Error(`${failed.length} of ${items.length} connections couldn't be removed (${failed[0].error}); the other ${items.length - failed.length} were.`);
  };

  const term = search.trim().toLowerCase();
  const matches = useCallback((text?: string) => Boolean(text?.toLowerCase().includes(term)), [term]);
  const apps = useMemo(() => byApp(state?.accounts ?? []), [state]);
  // An app by its name shows whole; otherwise only the accounts whose address matches.
  const shownApps = useMemo(() => term ? apps.flatMap((app) => {
    if (matches(app.name) || matches(app.toolkit)) return [app];
    const accounts = app.accounts.filter((account) => matches(account.main.account));
    return accounts.length ? [{ ...app, accounts }] : [];
  }) : apps, [apps, term, matches]);
  const found = useMemo(() => (catalog ?? []).filter((app) => !term || matches(app.name) || matches(app.slug) || matches(app.category) || matches(app.description)), [catalog, term, matches]);
  /** Working accounts at an app, each counted once however many times it was signed in to. */
  const connectedCount = (slug: string) => apps.find((app) => app.toolkit === slug)?.accounts.filter((account) => account.main.status === "ACTIVE").length ?? 0;
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
        <Section title="Connect through Composio" description="Composio holds the sign-ins, so Perry never sees a password or token.">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>Create a Composio account and copy an API key from <a href="https://composio.dev" target="_blank" rel="noopener noreferrer" className="link">composio.dev</a>.</li>
            <li>Paste your Composio key <Link href="#key-COMPOSIO_API_KEY" className="link">below</Link>.</li>
          </ol>
          {/* No key yet is not a failure (the key field is below); this is only for a load that failed. */}
          {state.error && <Alert variant="destructive" className="mt-4"><TriangleAlertIcon /><AlertTitle>Couldn&apos;t reach Composio</AlertTitle><AlertDescription>{state.error}</AlertDescription></Alert>}
          <div className="mt-5">{refreshButton}</div>
        </Section>
      </Page>
    );
  }

  const searchBox = (
    <InputGroup className="h-9 w-full sm:w-72">
      <InputGroupAddon><SearchIcon /></InputGroupAddon>
      <InputGroupInput type="search" aria-label="Search apps" placeholder={catalog ? `Search ${catalog.length >= 100 ? `${Math.floor(catalog.length / 100) * 100}+` : catalog.length} apps` : "Search apps"} value={search} autoComplete="off"
        onChange={(event) => setSearch(event.target.value)} />
      {search && <InputGroupAddon align="inline-end"><InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setSearch("")}><XIcon /></InputGroupButton></InputGroupAddon>}
    </InputGroup>
  );
  const popular = POPULAR.map((slug) => catalog?.find((app) => app.slug === slug)).filter((app): app is CatalogApp => Boolean(app));
  const rest = term ? found : found.filter((app) => !POPULAR.includes(app.slug));

  return (
    <Page wide title="Connectors" description="Let Perry work across the apps you already use. It checks what's connected each time it acts." actions={<div className="flex items-center gap-2">{searchBox}{refreshButton}</div>}>
      {state.error && <Alert variant="destructive" className="mb-6"><TriangleAlertIcon /><AlertTitle>Couldn&apos;t reach Composio</AlertTitle><AlertDescription>{state.error}</AlertDescription></Alert>}

      <Section title="Connected" description="The apps Perry can act on, and the accounts signed in to each. The sign-ins stay with Composio.">
        {state.accounts.length === 0
          ? !state.error && <EmptyState title="No accounts connected">Pick an app below. Sign-in happens on the provider&apos;s own page.</EmptyState>
          : shownApps.length === 0
            ? <p className="text-sm text-muted-foreground" role="status">No connected app or account matches &ldquo;{search.trim()}&rdquo;.</p>
            : (
              <ul aria-label="Connected apps" className="-mx-3 space-y-4">
                {shownApps.map((app) => <AppGroup key={app.toolkit} app={app} busy={busy} onConnect={(slug, from) => void connect(slug, from)} onRemove={remove} />)}
              </ul>
            )}
      </Section>

      {catalog === null ? <ListSkeleton /> : (
        <>
          {!term && popular.length > 0 && (
            <Section title="Popular">
              <ul aria-label="Popular apps" className="grid gap-1 sm:grid-cols-2">
                {popular.map((app) => <AppRow key={app.slug} app={app} connected={connectedCount(app.slug)} busy={busy} onConnect={(slug, from) => void connect(slug, from)} />)}
              </ul>
            </Section>
          )}
          <Section title={term ? `Apps matching “${search.trim()}”` : "All apps"} description={term ? `${rest.length} ${rest.length === 1 ? "app" : "apps"}` : undefined}>
            {rest.length === 0
              ? <EmptyState title="No app by that name" action={<Button variant="outline" size="sm" onClick={() => setSearch("")}>Clear search</Button>}>Try another word, like what it does: email, calendar, CRM.</EmptyState>
              : (
                <>
                  <ul aria-label={term ? "Matching apps" : "All apps"} className="grid gap-1 sm:grid-cols-2">
                    {rest.slice(0, shown).map((app) => <AppRow key={app.slug} app={app} connected={connectedCount(app.slug)} busy={busy} onConnect={(slug, from) => void connect(slug, from)} />)}
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
