"use client";

import { useTheme } from "next-themes";
import { ExternalLinkIcon, MonitorIcon, MoonIcon, RefreshCwIcon, ShieldAlertIcon, ShieldCheckIcon, SunIcon } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { useAction, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Access } from "@/convex/lib/commands";
import { errorText, useNow } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActionButton, CommandLine, CopyButton, EmptyState, List, ListSkeleton, Page, SecretInput, Section, StatusBadge, useTab, type Tone } from "../common";

const TABS = ["general", "keys", "telegram"] as const;

export function Settings() {
  const [tab, setTab] = useTab(TABS, "general");
  return (
    <Page title="Settings" description="How Perry thinks, what it may do on its own, and the keys it uses.">
      <Tabs value={tab} onValueChange={(value) => setTab(value as (typeof TABS)[number])}>
        <TabsList variant="line" className="mb-6 w-full justify-start gap-4 border-b pb-0 [&>button]:flex-none [&>button]:px-0 [&>button]:pb-2.5">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="keys">Keys</TabsTrigger>
          <TabsTrigger value="telegram">Telegram</TabsTrigger>
        </TabsList>
        <TabsContent value="general"><CodexAccount /><NewChatAccess /><Appearance /></TabsContent>
        <TabsContent value="keys"><Keys /></TabsContent>
        <TabsContent value="telegram"><Telegram /></TabsContent>
      </Tabs>
    </Page>
  );
}

/** Perry thinks with the owner's ChatGPT plan, through Codex on a connected computer. */
function CodexAccount() {
  const { dashboardKey } = useSession();
  const accounts = useQuery(api.codex.accounts, { key: dashboardKey });
  const requestAuth = useMutation(api.codex.requestAuth);

  return (
    <Section title="ChatGPT account" description="Perry thinks with your ChatGPT plan, through Codex on your computer. The sign-in stays on that computer.">
      {accounts === undefined && <ListSkeleton rows={1} />}
      {accounts?.length === 0 && (
        <EmptyState title="No computer connected" action={<div className="w-[min(360px,80vw)]"><CommandLine>perry start</CommandLine></div>}>
          Start Perry on the computer that will run Codex, then sign in here.
        </EmptyState>
      )}
      {accounts && accounts.length > 0 && (
        <List label="Codex accounts">
          {accounts.map((account) => {
            const pending = account.requestStatus === "queued" || account.requestStatus === "running";
            const signedIn = account.authMode === "chatgpt";
            const unavailable = !account.online ? "This computer is offline. Start Perry on it." : !account.available ? "Codex isn't installed or can't start on this computer." : null;
            const state: { tone: Tone; label: string } = !account.online ? { tone: "neutral", label: "Offline" }
              : !account.available ? { tone: "danger", label: "Codex unavailable" }
              : signedIn ? { tone: "success", label: "Signed in" } : { tone: "warning", label: "Signed out" };
            const plan = account.planType ? ` ${account.planType[0].toUpperCase()}${account.planType.slice(1)}` : "";
            return (
              <li key={account.id} className="px-4 py-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium">{account.name}</h3>
                      <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                    </div>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      {signedIn ? `ChatGPT${plan}` : account.authMode ? `Codex is using ${account.authMode}` : "Not signed in"}
                      {unavailable && ` · ${unavailable}`}
                    </p>
                  </div>
                  {signedIn
                    ? <ActionButton variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={Boolean(unavailable) || pending}
                        action={() => requestAuth({ key: dashboardKey, runnerId: account.id, kind: "logout" })}
                        confirm={{ title: `Sign out of Codex on ${account.name}?`, body: "Perry can't answer through this computer until you sign in again.", label: "Sign out" }}>Sign out</ActionButton>
                    : <ActionButton size="sm" disabled={Boolean(unavailable) || pending} action={() => requestAuth({ key: dashboardKey, runnerId: account.id, kind: "login" })}>Sign in with ChatGPT</ActionButton>}
                </div>
                {account.error && <p className="mt-2 text-sm text-destructive">{account.error}</p>}
                {account.requestStatus === "queued" && <Waiting>Waiting for the computer to pick this up…</Waiting>}
                {account.requestStatus === "running" && account.requestKind === "logout" && <Waiting>Signing out…</Waiting>}
                {account.requestStatus === "running" && account.requestKind === "login" && !account.userCode && <Waiting>Starting sign-in…</Waiting>}
                {account.requestStatus === "running" && account.userCode && account.verificationUrl && (
                  <div className="mt-3 rounded-xl border bg-muted/40 p-4" role="status">
                    <p className="text-sm font-medium">Finish signing in</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">Open the sign-in page, sign in to ChatGPT, and enter this code. This page updates by itself.</p>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <span className="rounded-lg border bg-background px-3 py-1.5 font-mono text-2xl font-semibold tracking-[0.15em]" translate="no">{account.userCode}</span>
                      <CopyButton value={account.userCode} label="Copy code" />
                      <Button size="sm" render={<a href={account.verificationUrl} target="_blank" rel="noopener noreferrer" />}>Open sign-in page<ExternalLinkIcon /></Button>
                    </div>
                  </div>
                )}
                {account.requestStatus === "error" && account.requestError && (
                  <p className="mt-2 text-sm text-pretty text-destructive">Sign-in didn&apos;t finish: {account.requestError}. Try again; each code works for a few minutes.</p>
                )}
              </li>
            );
          })}
        </List>
      )}
    </Section>
  );
}

function Waiting({ children }: { children: ReactNode }) {
  return <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground" role="status"><Spinner className="size-3" />{children}</p>;
}

/** A choice among a few, as cards you pick one of. */
function ChoiceCards<T extends string>({ label, value, options, onChange, disabled }: {
  label: string; value: T | undefined; disabled?: boolean;
  options: Array<{ value: T; title: string; body: string; icon: ReactNode; warning?: boolean }>;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid gap-2 sm:grid-cols-2">
      {options.map((option) => {
        const checked = value === option.value;
        return (
          <button key={option.value} type="button" role="radio" aria-checked={checked} disabled={disabled} onClick={() => onChange(option.value)}
            className={cn("flex items-start gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:bg-muted/40 disabled:opacity-60",
              checked && (option.warning ? "border-warning/60 ring-1 ring-warning/40" : "border-primary/60 ring-1 ring-primary/40"))}>
            <span className={cn("mt-0.5 shrink-0 [&>svg]:size-4", option.warning ? "text-warning" : "text-muted-foreground", checked && !option.warning && "text-primary")}>{option.icon}</span>
            <span className="grid gap-0.5">
              <span className="text-sm font-medium">{option.title}</span>
              <span className="text-sm text-pretty text-muted-foreground">{option.body}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The access a new chat starts with. Each chat keeps its own after that; a schedule's chat starts supervised. */
function NewChatAccess() {
  const { dashboardKey } = useSession();
  const current = useQuery(api.dashboard.getDefaultAccess, { key: dashboardKey });
  const setDefault = useMutation(api.dashboard.setDefaultAccess).withOptimisticUpdate((store, args) => {
    store.setQuery(api.dashboard.getDefaultAccess, { key: args.key }, args.access);
  });
  const choose = (access: Access) => void setDefault({ key: dashboardKey, access })
    .then(() => toast.success(access === "full" ? "New chats start with Full access." : "New chats start supervised."), (cause) => toast.error(errorText(cause)));
  return (
    <Section title="Access for new chats" description="What Perry may do without asking in chats you start from now on. Change any one chat from its composer, or with /access.">
      <ChoiceCards label="Access for new chats" value={current} disabled={current === undefined} onChange={choose} options={[
        { value: "supervised", title: "Supervised", icon: <ShieldCheckIcon />, body: "Works in its sandbox, and asks before anything beyond it. Your computer's policy and saved rules apply." },
        { value: "full", title: "Full access", icon: <ShieldAlertIcon />, warning: true, body: "No sandbox, and it never asks. It can change or delete anything your account can. Every command still shows in Activity." },
      ]} />
    </Section>
  );
}

function Appearance() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const options = [
    { value: "system", label: "System", icon: MonitorIcon },
    { value: "light", label: "Light", icon: SunIcon },
    { value: "dark", label: "Dark", icon: MoonIcon },
  ];
  return (
    <Section title="Appearance" description="Follows your system unless you pick one. Remembered in this browser.">
      <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-lg border bg-muted/50 p-0.5">
        {options.map((option) => {
          const checked = mounted && (theme ?? "system") === option.value;
          return (
            <button key={option.value} type="button" role="radio" aria-checked={checked} onClick={() => setTheme(option.value)}
              className={cn("flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                checked && "bg-background text-foreground shadow-sm")}>
              <option.icon className="size-4" />{option.label}
            </button>
          );
        })}
      </div>
    </Section>
  );
}

const SOURCE = { dashboard: "Saved here", environment: "From .env.local", none: "Not set" } as const;

/**
 * Service keys. A key entered here is write-only: it is saved on this
 * computer, and nothing reads one back to the page. You see whether it is set,
 * where it came from, and its last four characters.
 */
function Keys() {
  const { dashboardKey } = useSession();
  const keys = useQuery(api.dashboard.getKeys, { key: dashboardKey });
  const setKey = useMutation(api.dashboard.setKey);
  const clearKey = useMutation(api.dashboard.clearKey);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (keys === undefined) return <ListSkeleton />;

  const save = async (event: FormEvent, name: string) => {
    event.preventDefault();
    const value = (drafts[name] ?? "").trim();
    if (!value || saving) return;
    setSaving(name);
    setErrors((current) => ({ ...current, [name]: "" }));
    try {
      await setKey({ key: dashboardKey, name, value });
      setDrafts((current) => ({ ...current, [name]: "" }));
      toast.success(name.startsWith("TELEGRAM") ? "Saved. Perry listens to this bot within a few seconds." : "Saved. It takes effect on the next message.");
    } catch (cause) {
      setErrors((current) => ({ ...current, [name]: errorText(cause) }));
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <p className="mb-4 text-sm text-pretty text-muted-foreground">
        Saved on this computer and never shown again. A key saved here overrides one in <code className="font-mono text-xs">.env.local</code>; clearing it falls back to that one.
      </p>
      <List label="Service keys">
        {keys.map((entry) => {
          const id = `key-${entry.name}`;
          const error = errors[entry.name];
          return (
            <li key={entry.name} className="px-4 py-4">
              <form onSubmit={(event) => void save(event, entry.name)}>
                <Field data-invalid={Boolean(error) || undefined}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <FieldLabel htmlFor={id}>{entry.label}</FieldLabel>
                      <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{entry.hint}</p>
                    </div>
                    {entry.set
                      ? <StatusBadge tone="success"><span translate="no">Set{entry.preview ? ` · ${entry.preview}` : ""}</span></StatusBadge>
                      : <StatusBadge>Not set</StatusBadge>}
                  </div>
                  <div className="flex gap-2">
                    <div className="min-w-0 flex-1">
                      <SecretInput id={id} name={entry.name} value={drafts[entry.name] ?? ""} placeholder={entry.set ? "Paste a new value to replace it" : "Paste the key"}
                        invalid={Boolean(error)} describedBy={error ? `${id}-error` : undefined}
                        onChange={(value) => { setDrafts((current) => ({ ...current, [entry.name]: value })); setErrors((current) => ({ ...current, [entry.name]: "" })); }} />
                    </div>
                    <Button type="submit" className="h-10" disabled={!(drafts[entry.name] ?? "").trim() || saving !== null}>{saving === entry.name && <Spinner />}Save</Button>
                  </div>
                  {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
                </Field>
              </form>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                <span>{SOURCE[entry.source]}{entry.source === "environment" ? ". Saving here overrides it." : ""}</span>
                {entry.source === "dashboard" && (
                  <ActionButton variant="link" size="xs" className="h-auto px-0 text-xs text-destructive" action={() => clearKey({ key: dashboardKey, name: entry.name })} success={`${entry.label} cleared.`}
                    confirm={{ title: `Clear the ${entry.label}?`, body: "Perry falls back to .env.local if it has one. Otherwise anything that needs this key stops working.", label: "Clear" }}>
                    Clear
                  </ActionButton>
                )}
              </div>
            </li>
          );
        })}
      </List>
      <Section title="Dashboard key" description="The key that guards this page can't be changed from behind it, which keeps a lockout recoverable. Change DASHBOARD_KEY in .env.local in Perry's folder, then restart Perry:">
        <CommandLine>perry stop && perry start</CommandLine>
      </Section>
    </>
  );
}

const countdown = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Pairing: Perry answers nobody on Telegram until someone claims it with a code. */
function Telegram() {
  const { dashboardKey } = useSession();
  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  const startPairing = useMutation(api.dashboard.startPairing);
  const unclaim = useMutation(api.dashboard.unclaim);
  const checkBot = useAction(api.dashboard.checkBot);
  const now = useNow(1000);
  const [bot, setBot] = useState<{ ok: boolean; text: string } | null>(null);

  if (!status) return <ListSkeleton rows={2} />;
  const remaining = status.pairingExpiresAt !== undefined ? status.pairingExpiresAt - now : undefined;
  const live = Boolean(status.pairingCode) && (remaining === undefined || remaining > 0);

  return (
    <>
      {!status.telegramConfigured && (
        <Alert className="mb-6">
          <AlertTitle>Telegram isn&apos;t set up</AlertTitle>
          <AlertDescription>Telegram is optional. To talk to Perry there, add a bot token under Keys first.</AlertDescription>
        </Alert>
      )}
      {status.claimed ? (
        <div className="flex flex-wrap items-start gap-4 rounded-xl border bg-card p-5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2"><h2 className="font-semibold">Paired</h2><StatusBadge tone="success">Working for {status.ownerName ?? "you"}</StatusBadge></div>
            <p className="mt-1 text-sm text-pretty text-muted-foreground">Messages from anyone else are ignored. Unpair to move Perry to another Telegram account.</p>
          </div>
          <ActionButton variant="outline" action={() => unclaim({ key: dashboardKey })} success="Unpaired. Generate a code to pair again."
            confirm={{ title: "Unpair Perry?", body: `Perry stops answering ${status.ownerName ?? "you"} on Telegram until someone pairs it again with a new code.`, label: "Unpair" }}>
            Unpair
          </ActionButton>
        </div>
      ) : (
        <div className="rounded-xl border bg-card p-5">
          <div className="flex items-center gap-2"><h2 className="font-semibold">Pair with Telegram</h2><StatusBadge tone="warning">Not paired</StatusBadge></div>
          <p className="mt-1 text-sm text-pretty text-muted-foreground">Send the code to your Perry bot. Whoever sends it first owns this Perry.</p>
          {live ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="rounded-xl border bg-muted/40 px-4 py-2 font-mono text-3xl font-semibold tracking-[0.2em]" translate="no" aria-label={`Pairing code ${status.pairingCode!.split("").join(" ")}`}>{status.pairingCode}</span>
              <CopyButton value={status.pairingCode!} label="Copy code" />
              {remaining !== undefined && <span className="nums text-sm text-muted-foreground">Expires in {countdown(remaining)}</span>}
            </div>
          ) : <p className="mt-4 text-sm text-muted-foreground">{status.pairingCode ? "That code expired." : "Generate a code, then send it to your bot."}</p>}
          <ActionButton className="mt-4" variant={live ? "outline" : "default"} action={() => startPairing({ key: dashboardKey })} success={live ? "New code ready. The old one no longer works." : undefined}>
            <RefreshCwIcon />{live ? "New code" : "Generate code"}
          </ActionButton>
        </div>
      )}
      {status.telegramConfigured && (
        <Section title="Bot" description="Perry asks Telegram for new messages while it runs, so nothing here has to be reachable from the internet.">
          <div className="flex flex-wrap items-center gap-3">
            <ActionButton variant="outline" size="sm" action={async () => {
              const result = await checkBot({ key: dashboardKey });
              setBot(result.ok ? { ok: true, text: `Listening as @${result.bot}. Message it on Telegram.` } : { ok: false, text: `The bot isn't working: ${result.error}` });
            }}>Check the bot</ActionButton>
            {bot && <p role="status" className={cn("text-sm", bot.ok ? "text-success" : "text-destructive")}>{bot.text}</p>}
          </div>
        </Section>
      )}
    </>
  );
}
