"use client";

import { useTheme } from "next-themes";
import { ExternalLinkIcon, MessageCircleIcon, MonitorIcon, MoonIcon, RefreshCwIcon, SendIcon, ShieldAlertIcon, ShieldCheckIcon, SmartphoneIcon, SunIcon, UserIcon } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { useAction, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { EngineView } from "@/convex/engines";
import { ACCESS_HINTS, ACCESS_LABELS, ACCESSES, type Access } from "@/convex/lib/commands";
import { SIGN_IN_LABELS, type LoginInteraction } from "@/convex/lib/engines";
import type { PetTheme } from "@/convex/pet";
import { ago, errorText, useNow } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ACCESS_ICONS } from "../chat/composer";
import { PetControl } from "../pet-control";
import { Shortcuts } from "../shortcuts";
import { Updates } from "../updates";
import { ActionButton, CommandLine, CopyButton, EmptyState, InfoTip, List, ListSkeleton, Page, SecretInput, Section, StatusBadge, useTab, type Tone } from "../common";

const TABS = ["general", "keys", "shortcuts", "telegram", "whatsapp"] as const;

export function Settings() {
  const [tab, setTab] = useTab(TABS, "general");
  return (
    <Page title="Settings" description="How Perry thinks, what it may do on its own, and the keys it uses.">
      <Tabs value={tab} onValueChange={(value) => setTab(value as (typeof TABS)[number])}>
        <TabsList variant="line" className="mb-6 w-full justify-start gap-4 border-b pb-0 [&>button]:flex-none [&>button]:px-0 [&>button]:pb-2.5">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="keys">Keys</TabsTrigger>
          <TabsTrigger value="shortcuts">Keyboard shortcuts</TabsTrigger>
          <TabsTrigger value="telegram">Telegram</TabsTrigger>
          <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
        </TabsList>
        <TabsContent value="general"><Engines /><NewChatAccess /><Manners /><Updates /><DesktopPet /><Appearance /></TabsContent>
        <TabsContent value="keys"><Keys /></TabsContent>
        <TabsContent value="shortcuts"><Shortcuts /></TabsContent>
        <TabsContent value="telegram"><Telegram /></TabsContent>
        <TabsContent value="whatsapp"><WhatsApp /></TabsContent>
      </Tabs>
    </Page>
  );
}

/**
 * Perry thinks with a coding agent on a connected computer, signed in with the
 * owner's own subscription: each computer's engines, and signing them in and out.
 */
function Engines() {
  const { dashboardKey } = useSession();
  const computers = useQuery(api.engines.list, { key: dashboardKey });

  return (
    <Section title="Engines" description="Perry thinks with a coding agent on your computer, signed in with your own subscription. The sign-in stays on that computer.">
      {computers === undefined && <ListSkeleton rows={1} />}
      {computers?.length === 0 && (
        <EmptyState title="No computer connected" action={<div className="w-[min(360px,80vw)]"><CommandLine>perry start</CommandLine></div>}>
          Start Perry on the computer that will do the work, then sign in to an engine here.
        </EmptyState>
      )}
      {computers && computers.length > 0 && (
        <List label="Engines">
          {computers.map((computer) => (
            <li key={computer.id} className="px-4 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium">{computer.name}</h3>
                <StatusBadge tone={computer.online ? "success" : "neutral"}>{computer.online ? "Online" : "Offline"}</StatusBadge>
              </div>
              {!computer.online && <p className="mt-0.5 text-sm text-muted-foreground">This computer is offline. Start Perry on it.</p>}
              {computer.online && computer.engines.length === 0 && <Waiting>Waiting for this computer to say which engines it has…</Waiting>}
              <div className="mt-2 divide-y">
                {computer.engines.map((engine) => <EngineRow key={engine.kind} runnerId={computer.id} computer={computer.name} online={computer.online} engine={engine} />)}
              </div>
            </li>
          ))}
        </List>
      )}
    </Section>
  );
}

/** One engine on one computer: whether it is there and signed in, and signing it in or out. */
function EngineRow({ runnerId, computer, online, engine }: { runnerId: Id<"runners">; computer: string; online: boolean; engine: EngineView }) {
  const { dashboardKey } = useSession();
  const requestAuth = useMutation(api.engines.requestAuth);
  const request = engine.request;
  const pending = request?.status === "queued" || request?.status === "running";
  const unavailable = !online ? "This computer is offline." : !engine.installed ? `${engine.label} isn't installed or can't start on this computer.` : null;
  const state: { tone: Tone; label: string } = !online ? { tone: "neutral", label: "Offline" }
    : !engine.installed ? { tone: "danger", label: `${engine.label} unavailable` }
    : engine.signedIn ? { tone: "success", label: "Signed in" } : { tone: "warning", label: "Signed out" };
  const plan = engine.auth.plan ? ` ${engine.auth.plan[0].toUpperCase()}${engine.auth.plan.slice(1)}` : "";
  const account = engine.signedIn
    ? `${engine.auth.label ?? "Signed in"}${plan}${engine.auth.email ? ` · ${engine.auth.email}` : ""}`
    : engine.auth.type ? `${engine.label} is using ${engine.auth.label ?? engine.auth.type}` : "Not signed in";
  const interaction = request?.status === "running" ? request.interaction : undefined;
  const ask = (kind: "login" | "logout") => requestAuth({ key: dashboardKey, runnerId, engine: engine.kind, kind });
  return (
    <div className="py-3 first:pt-1 last:pb-0" aria-label={`${engine.label} on ${computer}`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{engine.label}</span>
            <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
            {engine.version && <span className="text-xs text-muted-foreground">{engine.version}</span>}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{account}{unavailable && ` · ${unavailable}`}</p>
          {engine.message && <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{engine.message}</p>}
        </div>
        {engine.signedIn
          ? <ActionButton variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={Boolean(unavailable) || pending}
              action={() => ask("logout")}
              confirm={{ title: `Sign out of ${engine.label} on ${computer}?`, body: `Perry can't use ${engine.label} on this computer until you sign in again.`, label: "Sign out" }}>Sign out</ActionButton>
          : <ActionButton size="sm" disabled={Boolean(unavailable) || pending} action={() => ask("login")}>{SIGN_IN_LABELS[engine.kind]}</ActionButton>}
      </div>
      {engine.error && <p className="mt-2 text-sm text-destructive">{engine.error}</p>}
      {request?.status === "queued" && <Waiting>Waiting for the computer to pick this up…</Waiting>}
      {request?.status === "running" && request.kind === "logout" && <Waiting>Signing out…</Waiting>}
      {request?.status === "running" && request.kind === "login" && !interaction && <Waiting>Starting sign-in…</Waiting>}
      {interaction && <LoginSteps engine={engine.label} interaction={interaction} />}
      {request?.status === "error" && request.error && (request.kind === "logout"
        ? <p className="mt-2 text-sm text-pretty text-destructive">Sign-out didn&apos;t finish: {request.error}.</p>
        : <p className="mt-2 text-sm text-pretty text-destructive">Sign-in didn&apos;t finish: {request.error}. Try again; each code works for a few minutes.</p>)}
    </div>
  );
}

/** What the owner does to finish signing in: a code to enter, a page to open, or a command to run on the computer. */
function LoginSteps({ engine, interaction }: { engine: string; interaction: LoginInteraction }) {
  return (
    <div className="mt-3 rounded-xl border bg-muted/40 p-4" role="status">
      <p className="text-sm font-medium">Finish signing in</p>
      {interaction.type === "deviceCode" && (
        <>
          <p className="mt-0.5 text-sm text-muted-foreground">Open the sign-in page, sign in, and enter this code. This page updates by itself.</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="rounded-lg border bg-background px-3 py-1.5 font-mono text-2xl font-semibold tracking-[0.15em]" translate="no">{interaction.userCode}</span>
            <CopyButton value={interaction.userCode} label="Copy code" />
            <Button size="sm" render={<a href={interaction.verificationUrl} target="_blank" rel="noopener noreferrer" />}>Open sign-in page<ExternalLinkIcon /></Button>
          </div>
        </>
      )}
      {interaction.type === "browser" && (
        <>
          <p className="mt-0.5 text-sm text-muted-foreground">Open the sign-in page and sign in to {engine}. This page updates by itself.</p>
          <Button size="sm" className="mt-3" render={<a href={interaction.url} target="_blank" rel="noopener noreferrer" />}>Open sign-in page<ExternalLinkIcon /></Button>
        </>
      )}
      {interaction.type === "terminal" && (
        <>
          <p className="mt-0.5 text-sm text-muted-foreground">Run this in a terminal on that computer, and follow what it says. This page updates by itself.</p>
          <div className="mt-3 max-w-md"><CommandLine>{interaction.command}</CommandLine></div>
        </>
      )}
      {interaction.type === "credentials" && <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{interaction.message}</p>}
    </div>
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
    .then(() => toast.success(`New chats start on ${ACCESS_LABELS[access]}.`), (cause) => toast.error(errorText(cause)));
  const Icon = current ? ACCESS_ICONS[current] : ShieldCheckIcon;
  return (
    <Section title="Access for new chats" description="What Perry may do without asking in chats you start. Change any chat from its composer, or with /access.">
      <Select modal={false} items={ACCESSES.map((mode) => ({ value: mode, label: ACCESS_LABELS[mode] }))} value={current ?? null} onValueChange={(value) => { if (value) choose(value as Access); }} disabled={current === undefined}>
        <SelectTrigger aria-label="Access for new chats" className={cn("w-56", current === "full" && "text-warning")}><Icon className="size-4" /><SelectValue /></SelectTrigger>
        <SelectContent className="w-56">
          {ACCESSES.map((mode) => {
            const ItemIcon = ACCESS_ICONS[mode];
            return (
              <SelectItem key={mode} value={mode}>
                <ItemIcon className={cn("size-4", mode === "full" && "text-warning")} />
                <span className="flex-1">{ACCESS_LABELS[mode]}</span>
                <InfoTip>{ACCESS_HINTS[mode]}</InfoTip>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </Section>
  );
}

const LIMITS = [
  { value: "none", label: "No limit" },
  ...[3, 5, 8, 12].map((n) => ({ value: String(n), label: `${n} a day` })),
];

/**
 * When Perry's own messages (schedules, watches, the heartbeat) may reach
 * your phone. Due reminders always do, and web chats never buzz anything.
 */
function Manners() {
  const { dashboardKey } = useSession();
  const manners = useQuery(api.dashboard.getManners, { key: dashboardKey });
  const save = useMutation(api.dashboard.setManners);
  const [quiet, setQuiet] = useState({ on: false, start: "22:00", end: "07:00" });
  useEffect(() => {
    if (manners) setQuiet({ on: Boolean(manners.quietHours), start: manners.quietHours?.start ?? "22:00", end: manners.quietHours?.end ?? "07:00" });
  }, [manners]);
  const store = (next: { quietHours?: { start: string; end: string }; dailyLimit?: number }, success: string) =>
    void save({ key: dashboardKey, ...next }).then(() => toast.success(success), (cause) => toast.error(errorText(cause)));
  const limit = manners?.dailyLimit;
  const hours = (on: boolean, start = quiet.start, end = quiet.end) => on ? { quietHours: { start, end } } : {};
  return (
    <Section title="Messages Perry sends on his own" description="Schedules, page watches and the heartbeat. What arrives in quiet hours or past the day's limit waits, and comes as one message when it may. Due reminders always go.">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Switch checked={quiet.on} disabled={!manners} aria-label="Quiet hours"
              onCheckedChange={(on) => { setQuiet({ ...quiet, on }); store({ ...hours(on), dailyLimit: limit }, on ? `Quiet from ${quiet.start} to ${quiet.end}.` : "Quiet hours off."); }} />
            Quiet hours
          </label>
          <span className="text-sm text-muted-foreground">from</span>
          <Input type="time" aria-label="Quiet from" className="w-28" value={quiet.start} disabled={!quiet.on}
            onChange={(event) => setQuiet({ ...quiet, start: event.target.value })}
            onBlur={() => quiet.on && store({ ...hours(true), dailyLimit: limit }, `Quiet from ${quiet.start} to ${quiet.end}.`)} />
          <span className="text-sm text-muted-foreground">to</span>
          <Input type="time" aria-label="Quiet until" className="w-28" value={quiet.end} disabled={!quiet.on}
            onChange={(event) => setQuiet({ ...quiet, end: event.target.value })}
            onBlur={() => quiet.on && store({ ...hours(true), dailyLimit: limit }, `Quiet from ${quiet.start} to ${quiet.end}.`)} />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium">At most</span>
          <Select modal={false} items={LIMITS} value={limit ? String(limit) : "none"} disabled={!manners}
            onValueChange={(value) => { if (!value) return; const n = value === "none" ? undefined : Number(value); store({ ...hours(quiet.on), dailyLimit: n }, n ? `At most ${n} a day.` : "No daily limit."); }}>
            <SelectTrigger aria-label="Daily limit" className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>{LIMITS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
          </Select>
          {manners && manners.waiting > 0 && <StatusBadge tone="info">{manners.waiting} waiting</StatusBadge>}
        </div>
        <p className="text-sm text-muted-foreground">When you let three messages from the same schedule or watch go unanswered, Perry asks once whether to pause it.</p>
      </div>
    </Section>
  );
}

/** Perry on the desktop: the platypus, turned on or off here. */
function DesktopPet() {
  const { dashboardKey } = useSession();
  const pet = useQuery(api.pet.status, { key: dashboardKey });
  const setTheme = useAction(api.pet.setTheme);
  // Shown as picked at once; the file is read back when the pet next checks in.
  const [picked, setPicked] = useState<PetTheme | null>(null);
  const theme = picked ?? pet?.theme;
  return (
    <Section title="Desktop pet" description="Perry as a platypus on your screen, with your chats, to-dos and what needs you a click away. Talk to him from anywhere with the Talk shortcut.">
      <PetControl />
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <ThemeChoice<PetTheme> label="Pet theme" value={theme} onChange={(value) => {
          setPicked(value);
          void setTheme({ key: dashboardKey, theme: value }).catch((cause) => { setPicked(null); toast.error(errorText(cause)); });
        }} />
        <p className="text-sm text-muted-foreground">His light or dark look, kept in <code className="font-mono text-[0.9em]">pet.json</code>. He changes at once.</p>
      </div>
    </Section>
  );
}

function Appearance() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <Section title="Appearance" description="Follows your system unless you pick one. Remembered in this browser.">
      <ThemeChoice label="Theme" value={mounted ? (theme ?? "system") : undefined} onChange={setTheme} />
    </Section>
  );
}

const THEMES = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
] as const;

/** System, Light or Dark; none checked while the value is not known yet. */
function ThemeChoice<Value extends string>({ label, value, onChange }: { label: string; value: string | undefined; onChange: (value: Value) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border bg-muted/50 p-0.5">
      {THEMES.map((option) => {
        const checked = value === option.value;
        return (
          <button key={option.value} type="button" role="radio" aria-checked={checked} onClick={() => onChange(option.value as Value)}
            className={cn("flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
              checked && "bg-background text-foreground shadow-sm")}>
            <option.icon className="size-4" />{option.label}
          </button>
        );
      })}
    </div>
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
      <Logins />
      <Section title="Dashboard key" description="The key that guards this page can't be changed from behind it, which keeps a lockout recoverable. Change DASHBOARD_KEY in .env.local in Perry's folder, then restart Perry:">
        <CommandLine>perry stop && perry start</CommandLine>
      </Section>
    </>
  );
}

const NO_LOGIN = { label: "", url: "", username: "", value: "" };

/**
 * The owner's logins and secrets, for Perry to sign in to websites with
 * computer use. Sent in a chat, one lands here and leaves the chat. Like the
 * keys above, a password goes in and is never shown again: changing one means
 * saving it again under the same name and username.
 */
function Logins() {
  const { dashboardKey } = useSession();
  const logins = useQuery(api.dashboard.getVault, { key: dashboardKey });
  const saveLogin = useMutation(api.dashboard.saveToVault);
  const removeLogin = useMutation(api.dashboard.removeFromVault);
  const now = useNow();
  const [draft, setDraft] = useState(NO_LOGIN);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const edit = (field: keyof typeof NO_LOGIN, value: string) => { setDraft((current) => ({ ...current, [field]: value })); setError(""); };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.label.trim() || !draft.value.trim() || saving) return;
    setSaving(true);
    try {
      await saveLogin({ key: dashboardKey, label: draft.label, url: draft.url || undefined, username: draft.username || undefined, value: draft.value });
      setDraft(NO_LOGIN);
      toast.success("Saved. Perry can sign in with it from the next message.");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Logins and secrets" description="For Perry to sign in to websites with computer use. Send one in a chat and Perry moves it here, out of the chat. Passwords are never shown again.">
      {logins === undefined ? <ListSkeleton /> : logins.length === 0 ? (
        <EmptyState title="No logins saved">Add one below, or send it to Perry in a chat.</EmptyState>
      ) : (
        <List label="Logins and secrets">
          {logins.map((login) => (
            <li key={login.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{login.label}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {[login.username, login.url].filter(Boolean).join(" · ") || "No username or site"}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {login.by === "assistant" ? "Moved here from a chat" : "Added here"} {ago(login.updatedAt, now)}
                  {login.lastUsedAt ? ` · last used ${ago(login.lastUsedAt, now)}` : " · not used yet"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => { setDraft({ label: login.label, url: login.url ?? "", username: login.username ?? "", value: "" }); setError(""); document.getElementById("login-value")?.focus(); }}>
                  Change
                </Button>
                <ActionButton variant="ghost" size="sm" className="text-destructive" action={() => removeLogin({ key: dashboardKey, id: login.id })} success={`${login.label} deleted.`}
                  confirm={{ title: `Delete the ${login.label} login?`, body: "Perry can no longer sign in with it. This cannot be undone.", label: "Delete" }}>
                  Delete
                </ActionButton>
              </div>
            </li>
          ))}
        </List>
      )}
      <form onSubmit={(event) => void save(event)} className="mt-3 rounded-xl border bg-card p-4">
        <Field data-invalid={Boolean(error) || undefined}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <FieldLabel htmlFor="login-label">Name</FieldLabel>
              <Input id="login-label" value={draft.label} placeholder="Netflix" autoComplete="off" onChange={(event) => edit("label", event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <FieldLabel htmlFor="login-url">Site</FieldLabel>
              <Input id="login-url" value={draft.url} placeholder="https://www.netflix.com/login" autoComplete="off" spellCheck={false} onChange={(event) => edit("url", event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <FieldLabel htmlFor="login-username">Username or email</FieldLabel>
              <Input id="login-username" value={draft.username} autoComplete="off" spellCheck={false} onChange={(event) => edit("username", event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <FieldLabel htmlFor="login-value">Password or secret</FieldLabel>
              <SecretInput id="login-value" name="login-value" value={draft.value} placeholder="Never shown again" invalid={Boolean(error)} describedBy={error ? "login-error" : undefined}
                onChange={(value) => edit("value", value)} />
            </div>
          </div>
          {error && <FieldError id="login-error">{error}</FieldError>}
        </Field>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">The same name and username replaces a saved one.</p>
          <Button type="submit" size="sm" disabled={!draft.label.trim() || !draft.value.trim() || saving}>{saving && <Spinner />}Save</Button>
        </div>
      </form>
    </Section>
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
      {status.telegramPaired ? (
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

const WHATSAPP_MODES: Array<{ value: "separate" | "self"; title: string; body: string; icon: ReactNode; warning?: boolean }> = [
  { value: "separate", title: "A separate number", body: "A spare SIM or eSIM just for Perry. You message it like a contact; a ban would only take that number.", icon: <SmartphoneIcon /> },
  { value: "self", title: "My own number", body: "Perry links to your WhatsApp, and you talk in your “Message yourself” chat. A ban would take your own WhatsApp with it.", icon: <UserIcon />, warning: true },
];

/**
 * WhatsApp, as a linked device (server/whatsapp.ts): choose a number, link it
 * by QR or a code typed on the phone, and for a separate number, claim it
 * from your own WhatsApp with the pairing code.
 */
function WhatsApp() {
  const { dashboardKey } = useSession();
  const state = useQuery(api.whatsapp.status, { key: dashboardKey });
  const startLinking = useMutation(api.whatsapp.startLinking);
  const unlink = useMutation(api.whatsapp.unlink);
  const newCode = useMutation(api.whatsapp.newPairingCode);
  const setHome = useMutation(api.whatsapp.setHomeChannel);
  /** Picked here, else the way it was linked before, else a separate number. */
  const [picked, setMode] = useState<"separate" | "self" | null>(null);
  const now = useNow(1000);
  const [byCode, setByCode] = useState(false);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");

  if (!state) return <ListSkeleton rows={2} />;
  const mode = picked ?? state.mode ?? "separate";
  // Before anything is linked, a dropped connection is still linking: the QR or code comes back on its own.
  const linking = state.wanted && (["starting", "qr", "code"].includes(state.status) || (state.status === "disconnected" && !state.number));
  const linked = state.wanted && !linking && (state.status === "connected" || state.status === "disconnected");
  const refreshed = state.updatedAt ? `Updated ${ago(state.updatedAt, now)}` : null;
  const link = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      await startLinking({ key: dashboardKey, mode, ...(byCode ? { phone } : {}) });
    } catch (cause) {
      setError(errorText(cause));
    }
  };
  const phoneOf = state.mode === "self" ? "your" : "Perry's";

  return (
    <>
      <Alert className="mb-6">
        <ShieldAlertIcon />
        <AlertTitle>WhatsApp may ban the number</AlertTitle>
        <AlertDescription>WhatsApp doesn&apos;t allow automating an account, so Perry links as a device, like WhatsApp Web. It only ever talks to you, which keeps the risk down, but a ban is possible.</AlertDescription>
      </Alert>

      {!state.wanted && (
        <form onSubmit={(event) => void link(event)} className="space-y-4">
          {state.status === "expired" && <Alert><AlertTitle>The code ran out</AlertTitle><AlertDescription>Nobody linked it in time, so Perry stopped making new ones. Get a new code when your phone is ready.</AlertDescription></Alert>}
          {state.status === "logged-out" && <Alert variant="destructive"><AlertTitle>Unlinked</AlertTitle><AlertDescription>{state.error ?? "WhatsApp was unlinked on the phone."} Link it again below.</AlertDescription></Alert>}
          <ChoiceCards label="Which number Perry uses" value={mode} options={WHATSAPP_MODES} onChange={setMode} />
          <div className="rounded-xl border bg-card p-4">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={byCode} onChange={(event) => setByCode(event.target.checked)} className="size-4 accent-primary" />
              Link with a code typed on the phone instead of scanning a QR
            </label>
            {byCode && (
              <Field className="mt-3 max-w-xs" data-invalid={Boolean(error) || undefined}>
                <FieldLabel htmlFor="whatsapp-phone">{mode === "self" ? "Your" : "Perry's"} phone number</FieldLabel>
                <Input id="whatsapp-phone" inputMode="tel" autoComplete="tel" placeholder="+91 98765 43210" value={phone} onChange={(event) => setPhone(event.target.value)} />
              </Field>
            )}
            {error && <FieldError className="mt-2">{error}</FieldError>}
          </div>
          <Button type="submit">{state.status === "expired" ? "Get a new code" : "Link WhatsApp"}</Button>
        </form>
      )}

      {linking && (
        <div className="rounded-xl border bg-card p-5">
          <div className="flex items-center gap-2"><h2 className="font-semibold">Link {state.mode === "self" ? "your WhatsApp" : "Perry's number"}</h2><StatusBadge tone="info">Waiting for the phone</StatusBadge></div>
          {state.status === "qr" && state.qr && (
            <div className="mt-4 flex flex-wrap items-start gap-6">
              {/* eslint-disable-next-line @next/next/no-img-element -- a QR made on this computer */}
              <img src={state.qr} alt="WhatsApp link QR code" width={220} height={220} className="rounded-lg bg-white p-2" />
              <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
                <li>On {phoneOf} phone, open WhatsApp.</li>
                <li>Settings › Linked devices › Link a device.</li>
                <li>Scan this code. It changes every 20 seconds or so, as on WhatsApp Web; scan the one showing.</li>
              </ol>
              {refreshed && <p className="basis-full text-xs text-muted-foreground" role="status">{refreshed}</p>}
            </div>
          )}
          {state.status === "code" && state.code && (
            <div className="mt-4 space-y-3">
              <span className="inline-block rounded-xl border bg-muted/40 px-4 py-2 font-mono text-3xl font-semibold tracking-[0.2em]" translate="no">{state.code}</span>
              <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
                <li>On {phoneOf} phone: WhatsApp › Settings › Linked devices › Link a device.</li>
                <li>Tap &ldquo;Link with phone number instead&rdquo;, then type this code.</li>
              </ol>
              <p className="text-xs text-muted-foreground" role="status">A new code comes every couple of minutes until you use one; type the one showing.{refreshed ? ` ${refreshed}.` : ""}</p>
            </div>
          )}
          {state.status === "starting" && <Waiting>Starting WhatsApp…</Waiting>}
          {state.error && <p className="mt-3 text-sm text-destructive">{state.error}</p>}
          <ActionButton className="mt-4" variant="outline" action={() => unlink({ key: dashboardKey })}>Cancel</ActionButton>
        </div>
      )}

      {linked && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start gap-4 rounded-xl border bg-card p-5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold">{state.mode === "self" ? "Your WhatsApp" : "Perry's number"}{state.number ? ` · ${state.number}` : ""}</h2>
                {state.status === "connected"
                  ? <StatusBadge tone={state.paired ? "success" : "warning"}>{state.paired ? "Linked" : "Linked, waiting for you"}</StatusBadge>
                  : <StatusBadge tone="warning">Reconnecting</StatusBadge>}
              </div>
              <p className="mt-1 text-sm text-pretty text-muted-foreground">
                {state.mode === "self"
                  ? "Talk to Perry in your “Message yourself” chat. Its replies there start with \u{1F916}."
                  : state.paired ? "Message this number from your WhatsApp. Anyone else gets no answer." : "Now claim it from your own WhatsApp with the code below."}
              </p>
              {state.status === "disconnected" && state.error && <p className="mt-1 text-sm text-muted-foreground">{state.error}</p>}
            </div>
            <ActionButton variant="outline" action={() => unlink({ key: dashboardKey })} success="Unlinked."
              confirm={{ title: "Unlink WhatsApp?", body: "Perry logs out of WhatsApp and stops answering there. You can link it again any time.", label: "Unlink" }}>
              Unlink
            </ActionButton>
          </div>
          {state.mode === "separate" && !state.paired && (
            <div className="rounded-xl border bg-card p-5">
              <h3 className="font-medium">Send this from your own WhatsApp to {state.number ?? "Perry's number"}</h3>
              {state.pairingCode ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <span className="rounded-xl border bg-muted/40 px-4 py-2 font-mono text-3xl font-semibold tracking-[0.2em]" translate="no">{state.pairingCode}</span>
                  <CopyButton value={state.pairingCode} label="Copy code" />
                </div>
              ) : <p className="mt-2 text-sm text-muted-foreground">That code expired.</p>}
              <ActionButton className="mt-3" variant="outline" size="sm" action={() => newCode({ key: dashboardKey })}><RefreshCwIcon />New code</ActionButton>
            </div>
          )}
        </div>
      )}

      {state.paired && state.telegramPaired && (
        <Section title="When you're away" description="Replies always go where you wrote. Perry's own messages, like the heartbeat and alerts, go to one app.">
          <ChoiceCards label="Where Perry reaches you" value={state.homeChannel}
            options={[
              { value: "telegram", title: "Telegram", body: "Background messages and approvals go to Telegram.", icon: <SendIcon /> },
              { value: "whatsapp", title: "WhatsApp", body: "Background messages and approvals go to WhatsApp.", icon: <MessageCircleIcon /> },
            ]}
            onChange={(channel) => void setHome({ key: dashboardKey, channel }).then(() => toast.success(`Perry will reach you on ${channel === "telegram" ? "Telegram" : "WhatsApp"}.`), (cause) => toast.error(errorText(cause)))} />
        </Section>
      )}
    </>
  );
}
