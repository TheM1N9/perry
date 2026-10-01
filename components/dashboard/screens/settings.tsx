"use client";

import { useTheme } from "next-themes";
import { ExternalLinkIcon, LockIcon, MessageCircleIcon, MonitorIcon, MoonIcon, RefreshCwIcon, SendIcon, ShieldAlertIcon, ShieldCheckIcon, SmartphoneIcon, SunIcon, UserIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import { useAction, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { EngineView } from "@/convex/engines";
import { ACCESS_HINTS, ACCESS_LABELS, ACCESSES, type Access } from "@/convex/lib/commands";
import { ENGINE_LABELS, SIGN_IN_LABELS, type EngineKind, type EngineUpdate, type LoginInteraction } from "@/convex/lib/engines";
import type { PetTheme } from "@/convex/pet";
import type { SecretName } from "@/convex/secrets";
import type { SettingsSection } from "@/lib/settings";
import { ago, errorText, useNow } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupCard } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import Link from "next/link";
import { TimePicker } from "@/components/ui/time-picker";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ACCESS_ICONS } from "../chat/composer";
import { PetControl } from "../pet-control";
import { PetDevices } from "../pet-devices";
import { Shortcuts } from "../shortcuts";
import { Updates } from "../updates";
import { Activity } from "./activity";
import { ApprovalRules, Computers, RecentRequests } from "./computer";
import { YourAssistant } from "./memory";
import { Usage, UsageMoved } from "./usage";
import { SaveStatus, useAutosave } from "../autosave";
import { EngineChoice, useEngineChoices } from "../default-engine";
import { ActionButton, CodeDisplay, CommandLine, EmptyState, InfoTip, List, ListSkeleton, SecretInput, Section, StatusBadge, type Tone } from "../common";

/**
 * What each section of Settings holds (lib/settings.ts names them and puts
 * them in groups). Each key sits beside what it unlocks; the Composio key is
 * with the connectors, in Apps & skills.
 */
const SECTIONS: Record<SettingsSection, () => ReactNode> = {
  general: () => <><YourAssistant /><Appearance /><Updates /></>,
  engines: () => <><UsageMoved /><DefaultEngine /><Engines /></>,
  usage: () => <Usage />,
  computers: () => <Computers />,
  access: () => <><NewChatAccess /><ApprovalRules /><RecentRequests /></>,
  notifications: () => <><Manners /><AwayChannel /></>,
  telegram: () => <Telegram />,
  whatsapp: () => <WhatsApp />,
  "desktop-pet": () => <><DesktopPet /><Shortcuts /></>,
  people: () => <People />,
  activity: () => <Activity />,
  logins: () => <Logins />,
  security: () => <Security />,
};

/** One section of Settings, inside the page and its nav (settings-shell.tsx). */
export function SettingsSectionScreen({ section }: { section: SettingsSection }) {
  const Content = SECTIONS[section];
  return <Content />;
}

/**
 * The engine Perry uses unless a chat or job picks another, chosen by the
 * owner and changed here. New web chats start on it; phone, schedule and task
 * chats without one of their own move to it from their next turn; a web chat
 * already started keeps its own. Unset, Perry asks before any turn.
 */
function DefaultEngine() {
  const { dashboardKey } = useSession();
  const current = useQuery(api.dashboard.getDefaultEngine, { key: dashboardKey });
  const reported = useEngineChoices();
  const setDefault = useMutation(api.dashboard.setDefaultEngine).withOptimisticUpdate((store, args) => {
    store.setQuery(api.dashboard.getDefaultEngine, { key: args.key }, args.engine);
  });
  const choose = (engine: EngineKind) => void setDefault({ key: dashboardKey, engine })
    .then(() => toast.success(`Perry now uses ${ENGINE_LABELS[engine]} by default.`), (cause) => toast.error(errorText(cause)));
  // The default stays listed while no connected computer reports it.
  const engines = reported && current && !reported.some((engine) => engine.kind === current)
    ? [...reported, { kind: current, label: ENGINE_LABELS[current], ready: false, detail: "No connected computer has it right now." }]
    : reported;
  return (
    <Section title="Default engine" description="What Perry thinks with in new chats, on your phone, and for schedules and tasks, unless one picks another model. Chats you already started keep theirs.">
      {current === undefined || engines === undefined ? <ListSkeleton rows={1} />
        : engines.length === 0 ? (
          <EmptyState title="No engines to choose from yet" action={<CommandLine>perry start</CommandLine>}>
            Start Perry on the computer that will do the work; its engines show here.
          </EmptyState>
        ) : (
          <div className="grid gap-3">
            {current === null && (
              <Alert variant="quiet">
                <AlertTitle>Choose one to start chatting</AlertTitle>
                <AlertDescription>Perry doesn&apos;t pick an engine for you. Until you choose, it asks instead of answering.</AlertDescription>
              </Alert>
            )}
            <EngineChoice engines={engines} value={current ?? undefined} current={current ?? undefined} onChange={choose} />
          </div>
        )}
    </Section>
  );
}

/**
 * Perry thinks with a coding agent on a connected computer, signed in with the
 * owner's own subscription: each computer's engines, and signing them in and out.
 * The Gemini API key, Antigravity's way in, is entered here too.
 */
function Engines() {
  const { dashboardKey } = useSession();
  const computers = useQuery(api.engines.list, { key: dashboardKey });

  return (
    <Section title="Engines" tip="Coding agents on your computers, signed in with your own subscriptions. Each sign-in stays on its computer.">
      {computers === undefined && <ListSkeleton rows={1} />}
      {computers?.length === 0 && <EmptyState title="No computer connected" action={<CommandLine>perry start</CommandLine>} />}
      {computers && computers.length > 0 && (
        <div className="space-y-6">
          {computers.map((computer) => (
            <div key={computer.id} aria-label={computer.name} role="group">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="font-medium">{computer.name}</h3>
                <StatusBadge>{computer.online ? "Online" : "Offline"}</StatusBadge>
              </div>
              {!computer.online && <p className="mt-0.5 text-sm text-muted-foreground">This computer is offline. Start Perry on it.</p>}
              {computer.online && computer.engines.length === 0 && <Waiting>Waiting for this computer to say which engines it has…</Waiting>}
              <List label={`Engines on ${computer.name}`} className="mt-1">
                {computer.engines.map((engine) => <li key={engine.kind}><EngineRow runnerId={computer.id} computer={computer.name} online={computer.online} engine={engine} /></li>)}
              </List>
            </div>
          ))}
        </div>
      )}
      <KeyRow name="GEMINI_API_KEY" className="mt-4 border-t" />
    </Section>
  );
}

/** One engine on one computer: whether it is there and signed in, and signing it in or out. The welcome page shows it too. */
export function EngineRow({ runnerId, computer, online, engine }: { runnerId: Id<"runners">; computer: string; online: boolean; engine: EngineView }) {
  const { dashboardKey } = useSession();
  const requestAuth = useMutation(api.engines.requestAuth);
  const request = engine.request;
  const pending = request?.status === "queued" || request?.status === "running";
  const unavailable = !online ? "This computer is offline." : !engine.installed ? `${engine.label} isn't installed or can't start on this computer.` : null;
  // Too old for Perry: it is updated before it is signed in.
  const outdated = engine.update?.need === "required";
  const state: { tone: Tone; label: string } = !online ? { tone: "neutral", label: "Offline" }
    : !engine.installed ? { tone: "danger", label: `${engine.label} unavailable` }
    : engine.signedIn ? { tone: "success", label: "Signed in" } : { tone: "warning", label: "Signed out" };
  const update: { tone: Tone; label: string } | null = online && engine.update
    ? engine.update.need === "required" ? { tone: "danger", label: "Update required" } : { tone: "info", label: "Update available" }
    : null;
  // One pill at most, for what needs you first; everything else is said in words beside it.
  const pill = update?.tone === "danger" ? update : state.tone === "danger" || state.tone === "warning" ? state : null;
  const plan = engine.auth.plan ? ` ${engine.auth.plan[0].toUpperCase()}${engine.auth.plan.slice(1)}` : "";
  const account = engine.signedIn
    ? `${engine.auth.label ?? "Signed in"}${plan}${engine.auth.email ? ` · ${engine.auth.email}` : ""}`
    : engine.auth.type ? `${engine.label} is using ${engine.auth.label ?? engine.auth.type}` : "Not signed in";
  const interaction = request?.status === "running" ? request.interaction : undefined;
  const ask = (kind: "login" | "logout", method?: string) => requestAuth({ key: dashboardKey, runnerId, engine: engine.kind, kind, ...(method ? { method } : {}) });
  // Antigravity is experimental: a Gemini API key is the way in, and Google's own sign-in comes with Google's warning.
  const experimental = engine.kind === "antigravity";
  return (
    <div className="py-3 first:pt-1 last:pb-0" aria-label={`${engine.label} on ${computer}`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{engine.label}</span>
            {pill && <StatusBadge tone={pill.tone}>{pill.label}</StatusBadge>}
            <span className="text-xs text-muted-foreground">
              {[experimental && "Experimental", pill !== state && state.label, update && pill !== update && update.label, engine.version].filter(Boolean).join(" · ")}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">{account}{unavailable && ` · ${unavailable}`}</p>
          {engine.message && <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{engine.message}</p>}
        </div>
        {engine.signedIn
          ? <ActionButton variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive" disabled={Boolean(unavailable) || pending}
              action={() => ask("logout")}
              confirm={{ title: `Sign out of ${engine.label} on ${computer}?`, body: `Perry can't use ${engine.label} on this computer until you sign in again.`, label: "Sign out" }}>Sign out</ActionButton>
          // Signing in shows only when it can happen: offline, missing or too old, the line above says why instead.
          : unavailable || pending || outdated ? null
          : experimental
            ? (
              <div className="flex flex-wrap gap-2">
                <ActionButton size="sm" action={() => ask("login", "gemini-api-key")}>Use Gemini API key</ActionButton>
                <ActionButton variant="outline" size="sm" action={() => ask("login", "oauth-personal")}
                  confirm={{ title: "Sign in with Google? (Experimental)", body: <GoogleWarning />, label: "Sign in anyway" }}>{SIGN_IN_LABELS[engine.kind]}</ActionButton>
              </div>
            )
            : <ActionButton size="sm" action={() => ask("login")}>{SIGN_IN_LABELS[engine.kind]}</ActionButton>}
      </div>
      {experimental && !engine.signedIn && (
        <p className="mt-2 text-sm text-pretty text-muted-foreground">
          Perry runs Google&apos;s own Antigravity ACP server on this computer, downloaded only when you turn it on. The recommended way in is a Gemini API key, saved below. Signing in with Google also works, at your own risk: <GoogleWarning inline />
        </p>
      )}
      {online && engine.update && <UpdateSteps engine={engine.label} computer={computer} update={engine.update} />}
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

/**
 * An engine whose CLI should be updated, and the command that does it on that
 * computer. Too old for Perry, it takes no new replies until it is; otherwise
 * it is only a newer release. Perry notices the update by itself.
 */
function UpdateSteps({ engine, computer, update }: { engine: string; computer: string; update: EngineUpdate }) {
  const required = update.need === "required";
  return (
    <div className={cn("mt-3 border-l-2 pl-3", required && "border-destructive")} role={required ? "alert" : "status"}>
      <p className={cn("text-sm font-medium", required && "text-destructive")}>{required ? `Update ${engine} to keep using it` : `${engine} ${update.latest} is out`}</p>
      <p className="mt-0.5 text-sm text-pretty text-muted-foreground">
        {required
          ? `${computer} has ${engine} ${update.version}, older than Perry works with (${update.minimum} or newer). Until it's updated, Perry won't start replies with it. Run this on ${computer}:`
          : `${computer} has ${update.version}. To update, run this on ${computer}:`}
      </p>
      <div className="mt-3 max-w-md"><CommandLine>{update.command}</CommandLine></div>
    </div>
  );
}

/** What the owner does to finish signing in: a code to enter, a page to open, or a command to run on the computer. */
function LoginSteps({ engine, interaction }: { engine: string; interaction: LoginInteraction }) {
  return (
    <div className="mt-3 border-l-2 border-primary/60 pl-3" role="status">
      <p className="text-sm font-medium">Finish signing in</p>
      {interaction.type === "deviceCode" && (
        <>
          <p className="mt-0.5 text-sm text-muted-foreground">Enter this code on the sign-in page.</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <CodeDisplay>{interaction.userCode}</CodeDisplay>
            <Button size="sm" render={<a href={interaction.verificationUrl} target="_blank" rel="noopener noreferrer" />}>Open sign-in page<ExternalLinkIcon /></Button>
          </div>
        </>
      )}
      {interaction.type === "browser" && (
        <>
          <p className="mt-0.5 text-sm text-muted-foreground">Sign in to {engine} on the sign-in page.</p>
          <Button size="sm" className="mt-3" render={<a href={interaction.url} target="_blank" rel="noopener noreferrer" />}>Open sign-in page<ExternalLinkIcon /></Button>
        </>
      )}
      {interaction.type === "terminal" && (
        <>
          <p className="mt-0.5 text-sm text-muted-foreground">Run this in a terminal on that computer.</p>
          <div className="mt-3 max-w-md"><CommandLine>{interaction.command}</CommandLine></div>
        </>
      )}
      {interaction.type === "credentials" && <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{interaction.message}</p>}
    </div>
  );
}

/** Google's own words on third-party access to Antigravity, from its FAQ. */
function GoogleWarning({ inline }: { inline?: boolean }) {
  const quote = (
    <>
      Google&apos;s <a className="link" href="https://antigravity.google/docs/faq/" target="_blank" rel="noopener noreferrer">Antigravity FAQ</a> says
      “Using third party software, tools, or services to access Antigravity is a violation of our Terms of Service … may be grounds for suspension or termination of your account.”
    </>
  );
  if (inline) return quote;
  return (
    <span className="grid gap-2 text-pretty">
      <span>{quote}</span>
      <span>Perry runs only Google&apos;s official ACP server, signed in with your own Google account in a browser on that computer, and never sees or keeps the sign-in. Google may still treat it as third-party access. A Gemini API key is the safer way in.</span>
    </span>
  );
}

function Waiting({ children }: { children: ReactNode }) {
  return <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground" role="status"><Spinner className="size-3" />{children}</p>;
}

/** A choice among a few, as cards you pick one of. */
function ChoiceCards<T extends string>({ label, value, options, onChange, disabled }: {
  label: string; value: T | undefined; disabled?: boolean;
  options: Array<{ value: T; title: string; body?: string; icon: ReactNode; warning?: boolean }>;
  onChange: (value: T) => void;
}) {
  return (
    <RadioGroup aria-label={label} value={value ?? null} disabled={disabled} onValueChange={(next) => onChange(next as T)} className="gap-2 sm:grid-cols-2">
      {options.map((option) => (
        <RadioGroupCard key={option.value} value={option.value} tone={option.warning ? "warning" : "default"}>
          <span className={cn("mt-0.5 shrink-0 [&>svg]:size-4", option.warning ? "text-warning" : "text-muted-foreground group-data-checked/radio-card:text-primary")}>{option.icon}</span>
          <span className="grid gap-0.5">
            <span className="text-sm font-medium">{option.title}</span>
            {option.body && <span className="text-sm text-pretty text-muted-foreground">{option.body}</span>}
          </span>
        </RadioGroupCard>
      ))}
    </RadioGroup>
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
    <Section title="Access for new chats" tip="What Perry may do without asking in a chat you start. Change any chat from its composer, or with /access.">
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
  const [quiet, setQuietState] = useState({ on: false, start: "22:00", end: "07:00" });
  // The latest hours, kept as they change: a time field can still change as focus leaves it, in the same event as the blur that saves.
  const latest = useRef(quiet);
  const setQuiet = (next: typeof quiet) => { latest.current = next; setQuietState(next); };
  useEffect(() => {
    if (!manners) return;
    latest.current = { on: Boolean(manners.quietHours), start: manners.quietHours?.start ?? "22:00", end: manners.quietHours?.end ?? "07:00" };
    setQuietState(latest.current);
  }, [manners]);
  const store = (next: { quietHours?: { start: string; end: string }; dailyLimit?: number }, success: string) =>
    void save({ key: dashboardKey, ...next }).then(() => toast.success(success), (cause) => toast.error(errorText(cause)));
  const limit = manners?.dailyLimit;
  const hours = (on: boolean, start = latest.current.start, end = latest.current.end) => on ? { quietHours: { start, end } } : {};
  const saveHours = () => { const { on, start, end } = latest.current; if (on) store({ ...hours(true, start, end), dailyLimit: limit }, `Quiet from ${start} to ${end}.`); };
  return (
    <Section title="Messages Perry sends on his own" description="Schedules, watches and the heartbeat. Due reminders always go."
      tip="What comes in quiet hours or past the day's limit waits, then arrives as one message.">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Switch checked={quiet.on} disabled={!manners} aria-label="Quiet hours"
              onCheckedChange={(on) => { setQuiet({ ...latest.current, on }); store({ ...hours(on), dailyLimit: limit }, on ? `Quiet from ${latest.current.start} to ${latest.current.end}.` : "Quiet hours off."); }} />
            Quiet hours
          </label>
          <span className="text-sm text-muted-foreground">from</span>
          <TimePicker aria-label="Quiet from" value={quiet.start} disabled={!quiet.on}
            onValueChange={(start) => setQuiet({ ...latest.current, start })} onBlur={saveHours} />
          <span className="text-sm text-muted-foreground">to</span>
          <TimePicker aria-label="Quiet until" value={quiet.end} disabled={!quiet.on}
            onValueChange={(end) => setQuiet({ ...latest.current, end })} onBlur={saveHours} />
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
      </div>
    </Section>
  );
}

/** Perry on the desktop: the platypus, turned on or off here. */
function DesktopPet() {
  const { dashboardKey } = useSession();
  const pet = useQuery(api.pet.status, { key: dashboardKey });
  const setTheme = useAction(api.pet.setTheme);
  const screenLook = useQuery(api.screen.getSetting, { key: dashboardKey });
  const setScreenLook = useMutation(api.screen.setSetting);
  // Shown as picked at once; the file is read back when the pet next checks in.
  const [picked, setPicked] = useState<PetTheme | null>(null);
  const theme = picked ?? pet?.theme;
  return (
    <Section title="Desktop pet">
      <PetControl />
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <ThemeChoice<PetTheme> label="Pet theme" value={theme} onChange={(value) => {
          setPicked(value);
          void setTheme({ key: dashboardKey, theme: value }).catch((cause) => { setPicked(null); toast.error(errorText(cause)); });
        }} />
        <p className="text-sm text-muted-foreground">On this computer. Others follow their system.</p>
      </div>
      <div className="mt-4 flex items-start gap-3">
        <Switch id="screen-look" checked={screenLook ?? true} disabled={screenLook === undefined} className="mt-0.5"
          onCheckedChange={(enabled) => void setScreenLook({ key: dashboardKey, enabled }).then(
            () => toast.success(enabled ? "Perry can look at your screen when a question needs it." : "Perry sees the screen only when you show him."),
            (cause) => toast.error(errorText(cause)))} />
        <div className="text-sm">
          <label htmlFor="screen-look" className="font-medium">Let Perry look at the screen when he needs to</label>
          <p className="mt-0.5 text-pretty text-muted-foreground">Only in chats, never in scheduled or background work. What he saw shows in the chat.</p>
        </div>
      </div>
      <PetDevices />
    </Section>
  );
}

function Appearance() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <Section title="Appearance">
      <ThemeChoice label="Theme" value={mounted ? (theme ?? "system") : undefined} onChange={setTheme} />
    </Section>
  );
}

const THEMES = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
] as const;

/** System, Light or Dark; none pressed while the value is not known yet. Pressing the one pressed keeps it. */
function ThemeChoice<Value extends string>({ label, value, onChange }: { label: string; value: string | undefined; onChange: (value: Value) => void }) {
  return (
    <ToggleGroup aria-label={label} value={value ? [value] : []} onValueChange={(next) => { if (next[0]) onChange(next[0] as Value); }}
      spacing={0.5} className="rounded-lg border bg-muted/50 p-0.5">
      {THEMES.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} className="rounded-md px-3 text-muted-foreground hover:bg-transparent aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm">
          <option.icon />{option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

const SOURCE = { dashboard: "Saved here", environment: "From .env.local", none: "Not set" } as const;

/**
 * One service key, entered beside what it unlocks: the Telegram bot token in
 * Telegram, the Gemini API key with the engines, the Composio key with the
 * connectors. A key entered here is write-only: it is saved on this computer,
 * and nothing reads one back to the page. You see whether it is set, where it
 * came from, and its last four characters. One saved here overrides one in
 * .env.local; clearing it falls back to that one.
 */
export function KeyRow({ name, className }: { name: SecretName; className?: string }) {
  const { dashboardKey } = useSession();
  const entry = useQuery(api.dashboard.getKeys, { key: dashboardKey })?.find((item) => item.name === name);
  const setKey = useMutation(api.dashboard.setKey);
  const clearKey = useMutation(api.dashboard.clearKey);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!entry) return <div className={className}><ListSkeleton rows={1} /></div>;
  const id = `key-${name}`;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const value = draft.trim();
    if (!value || saving) return;
    setSaving(true);
    setError("");
    try {
      await setKey({ key: dashboardKey, name, value });
      setDraft("");
      toast.success(name.startsWith("TELEGRAM") ? "Saved. Perry listens to this bot within a few seconds." : "Saved. It takes effect on the next message.");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={cn("py-4", className)} data-key={name}>
      <form onSubmit={(event) => void save(event)}>
        <Field data-invalid={Boolean(error) || undefined}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <FieldLabel htmlFor={id}>{entry.label}</FieldLabel>
              <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{entry.hint}</p>
            </div>
            {/* Not set is said once, in the line under the field. */}
            {entry.set && <StatusBadge tone="success"><span translate="no">Set{entry.preview ? ` · ${entry.preview}` : ""}</span></StatusBadge>}
          </div>
          <SecretInput id={id} name={name} value={draft} placeholder={entry.set ? "Paste a new value to replace it" : "Paste the key"}
            invalid={Boolean(error)} describedBy={error ? `${id}-error` : undefined} save={{ busy: saving }}
            onChange={(value) => { setDraft(value); setError(""); }} />
          {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
        </Field>
      </form>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
        <span>{SOURCE[entry.source]}{entry.source === "environment" ? ". Saving here overrides it." : entry.source === "dashboard" ? ", never shown again." : ""}</span>
        {entry.source === "dashboard" && (
          <ActionButton variant="link" size="xs" className="h-auto px-0 text-xs text-destructive" action={() => clearKey({ key: dashboardKey, name })} success={`${entry.label} cleared.`}
            confirm={{ title: `Clear the ${entry.label}?`, body: "Perry falls back to .env.local if it has one. Otherwise anything that needs this key stops working.", label: "Clear" }}>
            Clear
          </ActionButton>
        )}
      </div>
    </div>
  );
}

/** Settings → Dashboard key: the key that guards the dashboard, and locking this browser. */
function Security() {
  const { lock } = useSession();
  return (
    <>
      <Section title="Dashboard key" description="Change DASHBOARD_KEY in .env.local in Perry's folder, then restart Perry:"
        tip="It can't be changed from here, so a mistake can't lock you out.">
        <CommandLine>perry stop && perry start</CommandLine>
      </Section>
      <Section title="Lock this browser" description="This browser asks for the key again.">
        <Button variant="outline" onClick={lock}><LockIcon />Lock dashboard</Button>
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
  const ready = Boolean(draft.label.trim() && draft.value.trim());
  // The same name and username is a login already saved, which this replaces.
  const replacing = logins?.some((login) => login.label === draft.label.trim() && (login.username ?? "") === draft.username.trim());
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.label.trim() || !draft.value.trim() || saving) return;
    setSaving(true);
    try {
      await saveLogin({ key: dashboardKey, label: draft.label, url: draft.url || undefined, username: draft.username || undefined, value: draft.value });
      setDraft(NO_LOGIN);
      toast.success(`${draft.label.trim()} added. Perry can sign in with it from the next message.`);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section title="Logins & secrets" description="For Perry to sign in to websites. Passwords are never shown again."
      tip="Send one in a chat and Perry moves it here, out of the chat.">
      {logins === undefined ? <ListSkeleton /> : logins.length === 0 ? <EmptyState title="No logins saved" /> : (
        <List label="Logins & secrets">
          {logins.map((login) => (
            <li key={login.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
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
      <form onSubmit={(event) => void save(event)} className="mt-6" aria-label="Add a login">
        <h3 className="mb-3 text-sm font-medium">Add a login</h3>
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
        <div className="mt-3 flex min-h-7 flex-wrap items-center gap-2">
          <span className="flex-1" />
          {(ready || saving) && <Button type="submit" variant="outline" size="sm" disabled={saving} aria-busy={saving || undefined}>{saving && <Spinner />}{replacing ? "Replace login" : "Add login"}</Button>}
        </div>
      </form>
    </Section>
  );
}

/** What Perry remembers about one person: from the owner's chats, and from theirs, each forgettable. */
function Remembered({ items }: { items?: Array<{ id: Id<"memories">; text: string; from: "you" | "them" }> }) {
  const { dashboardKey } = useSession();
  const forget = useMutation(api.dashboard.deleteMemory);
  if (!items?.length) return null;
  return (
    <ul className="mt-2 grid gap-1 border-l pl-3">
      {items.map((item) => (
        <li key={item.id} className="group flex items-start justify-between gap-2 text-sm">
          <p className="min-w-0 text-pretty">
            <span className="text-foreground">{item.text}</span>
            <span className="ml-1.5 text-xs text-muted-foreground">{item.from === "you" ? "from your chats" : "from their chat"}</span>
          </p>
          <ActionButton variant="ghost" size="sm" className="h-6 shrink-0 px-2 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            action={() => forget({ key: dashboardKey, id: item.id })} success="Forgotten.">Forget</ActionButton>
        </li>
      ))}
    </ul>
  );
}

const PEOPLE_STATUS = { allowed: { label: "Talks with Perry", tone: "success" }, pending: { label: "Waiting for you", tone: "warning" }, blocked: { label: "Blocked", tone: "neutral" }, known: { label: "Not yet", tone: "neutral" } } as const;

/**
 * Who Perry talks with besides the owner, on WhatsApp and Telegram
 * (convex/contacts.ts): allowed once, by the owner, then both ways. Each chat
 * is sealed off from everything of the owner's; its brief is all Perry knows
 * of the owner there.
 */
function People() {
  const { dashboardKey } = useSession();
  const people = useQuery(api.contacts.listForDashboard, { key: dashboardKey });
  const remembered = useQuery(api.contacts.memoriesForDashboard, { key: dashboardKey });
  const set = useMutation(api.contacts.setForDashboard);
  const now = useNow();
  const [editing, setEditing] = useState<Id<"contacts"> | null>(null);

  return (
    <Section title="People" tip="What Perry remembers about someone from your chats is used only in yours, and from theirs only in theirs. You're asked before Perry first talks with anyone.">
      {people === undefined ? <ListSkeleton /> : people.length === 0 && !remembered?.others.length ? <EmptyState title="Nobody yet" /> : (
        <List label="People">
          {people.map((person) => (
            <li key={person.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium">{person.name}</p>
                    <StatusBadge tone={PEOPLE_STATUS[person.status].tone}>{PEOPLE_STATUS[person.status].label}</StatusBadge>
                  </div>
                  <p className="truncate text-sm text-muted-foreground">
                    {[person.kind === "group" ? "Group" : person.handle, person.channel === "whatsapp" ? "WhatsApp" : "Telegram"].filter(Boolean).join(" · ")} · {ago(person.updatedAt, now)}
                  </p>
                  {editing !== person.id && (
                    <p className="mt-1 text-sm text-pretty text-muted-foreground">
                      {person.brief ? <>Perry may share: <span className="text-foreground">{person.brief}</span></> : "Perry shares nothing about you with them."}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {person.chatId && <Button variant="ghost" size="sm" render={<Link href={`/chat/${person.chatId}`} />}>Open chat</Button>}
                  {editing !== person.id && <Button variant="ghost" size="sm" onClick={() => setEditing(person.id)}>Brief</Button>}
                  {person.status === "blocked"
                    ? <ActionButton variant="ghost" size="sm" action={() => set({ key: dashboardKey, id: person.id, status: "allowed" })} success={`Perry talks with ${person.name} again.`}>Allow</ActionButton>
                    : <ActionButton variant="ghost" size="sm" className="text-destructive" action={() => set({ key: dashboardKey, id: person.id, status: "blocked" })} success={`${person.name} is blocked.`}
                        confirm={{ title: `Block ${person.name}?`, body: "Perry stops answering them and will not write to them. You can allow them again here.", label: "Block" }}>Block</ActionButton>}
                </div>
              </div>
              <Remembered items={remembered?.byContact[person.id]} />
              {editing === person.id && (
                <Brief name={person.name} brief={person.brief ?? ""} onDone={() => setEditing(null)}
                  save={(brief) => set({ key: dashboardKey, id: person.id, brief })} />
              )}
            </li>
          ))}
        </List>
      )}
      {remembered && remembered.others.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-medium">Others you&apos;ve told Perry about</h3>
          <List label="Others you've told Perry about">
            {remembered.others.map((person) => (
              <li key={person.name} className="py-3">
                <p className="text-sm font-medium">{person.name}</p>
                <Remembered items={person.memories} />
              </li>
            ))}
          </List>
        </div>
      )}
    </Section>
  );
}

/** What Perry may share with one person, saved as you type; Done or Esc puts it away once it is saved. */
function Brief({ name, brief, save, onDone }: { name: string; brief: string; save: (brief: string) => Promise<unknown>; onDone: () => void }) {
  const text = useAutosave({ saved: brief, save });
  const done = () => void text.flush().then((ok) => { if (ok) onDone(); });
  return (
    <div className="mt-2 grid gap-1.5">
      <Textarea value={text.value} rows={3} autoFocus aria-label={`What Perry may share with ${name}`} placeholder={`What Perry may know and share with ${name}. "He can know my gym times."`} {...text.field}
        onChange={(event) => text.change(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) { event.preventDefault(); done(); } }} />
      <div className="flex items-center gap-3">
        <SaveStatus state={text.state} idle="Saves as you type." onRetry={() => void text.flush()} className="flex-1" />
        <Button variant="ghost" size="sm" onClick={done}>Done</Button>
      </div>
    </div>
  );
}

const countdown = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Telegram: the bot token, then pairing. Perry answers nobody there until someone claims it with a code. */
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
        <Alert variant="quiet" className="mb-6">
          <AlertTitle>Telegram isn&apos;t set up</AlertTitle>
          <AlertDescription>Add a bot token from @BotFather below.</AlertDescription>
        </Alert>
      )}
      {status.telegramPaired ? (
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2"><h2 className="font-semibold">Paired</h2><StatusBadge tone="success">Working for {status.ownerName ?? "you"}</StatusBadge></div>
            <p className="mt-1 text-sm text-pretty text-muted-foreground">Messages from anyone else are ignored.</p>
          </div>
          <ActionButton variant="outline" action={() => unclaim({ key: dashboardKey })} success="Unpaired. Generate a code to pair again."
            confirm={{ title: "Unpair Perry?", body: `Perry stops answering ${status.ownerName ?? "you"} on Telegram until someone pairs it again with a new code.`, label: "Unpair" }}>
            Unpair
          </ActionButton>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2"><h2 className="font-semibold">Pair with Telegram</h2><StatusBadge tone="warning">Not paired</StatusBadge></div>
          <p className="mt-1 text-sm text-pretty text-muted-foreground">Send the code to your Perry bot. Whoever sends it first owns this Perry.</p>
          {live ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <CodeDisplay label={`Pairing code ${status.pairingCode!.split("").join(" ")}`}>{status.pairingCode!}</CodeDisplay>
              {remaining !== undefined && <span className="nums text-sm text-muted-foreground">Expires in {countdown(remaining)}</span>}
            </div>
          ) : status.pairingCode ? <p className="mt-4 text-sm text-muted-foreground">That code expired.</p> : null}
          <ActionButton className="mt-4" variant={live ? "outline" : "default"} action={() => startPairing({ key: dashboardKey })} success={live ? "New code ready. The old one no longer works." : undefined}>
            <RefreshCwIcon />{live ? "New code" : "Generate code"}
          </ActionButton>
        </div>
      )}
      <Section title="Bot" tip="Perry asks Telegram for new messages, so nothing here has to be reachable from the internet.">
        <KeyRow name="TELEGRAM_BOT_TOKEN" className="pt-0" />
        {status.telegramConfigured && (
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <ActionButton variant="outline" size="sm" action={async () => {
              const result = await checkBot({ key: dashboardKey });
              setBot(result.ok ? { ok: true, text: `Listening as @${result.bot}. Message it on Telegram.` } : { ok: false, text: `The bot isn't working: ${result.error}` });
            }}>Check the bot</ActionButton>
            {bot && <p role="status" className={cn("text-sm", bot.ok ? "text-success" : "text-destructive")}>{bot.text}</p>}
          </div>
        )}
      </Section>
    </>
  );
}

const WHATSAPP_MODES: Array<{ value: "separate" | "self"; title: string; body: string; icon: ReactNode; warning?: boolean }> = [
  { value: "separate", title: "A separate number", body: "A spare SIM for Perry. A ban would only take that number.", icon: <SmartphoneIcon /> },
  { value: "self", title: "My own number", body: "You talk in “Message yourself”. A ban would take your own WhatsApp.", icon: <UserIcon />, warning: true },
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
      <Alert variant="quiet" className="mb-6">
        <ShieldAlertIcon />
        <AlertTitle>WhatsApp may ban the number</AlertTitle>
        <AlertDescription>Perry links as a device, like WhatsApp Web, which WhatsApp doesn&apos;t allow. A ban is possible.</AlertDescription>
      </Alert>

      {!state.wanted && (
        <form onSubmit={(event) => void link(event)} className="space-y-4">
          {state.status === "expired" && <Alert variant="quiet"><AlertTitle>The code ran out</AlertTitle><AlertDescription>Get a new code when your phone is ready.</AlertDescription></Alert>}
          {state.status === "logged-out" && <Alert variant="destructive"><AlertTitle>Unlinked</AlertTitle><AlertDescription>{state.error ?? "WhatsApp was unlinked on the phone."} Link it again below.</AlertDescription></Alert>}
          <ChoiceCards label="Which number Perry uses" value={mode} options={WHATSAPP_MODES} onChange={setMode} />
          <div>
            <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={byCode} onCheckedChange={setByCode} />
              Link with a code instead of a QR
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
        <div>
          <div className="flex items-baseline gap-2"><h2 className="font-semibold">Link {state.mode === "self" ? "your WhatsApp" : "Perry's number"}</h2><StatusBadge tone="info">Waiting for the phone</StatusBadge></div>
          {state.status === "qr" && state.qr && (
            <div className="mt-4 flex flex-wrap items-start gap-6">
              {/* eslint-disable-next-line @next/next/no-img-element -- a QR made on this computer */}
              <img src={state.qr} alt="WhatsApp link QR code" width={220} height={220} className="rounded-lg bg-white p-2" />
              <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
                <li>On {phoneOf} phone, open WhatsApp.</li>
                <li>Settings › Linked devices › Link a device.</li>
                <li>Scan this code. It changes every 20 seconds or so.</li>
              </ol>
              {refreshed && <p className="basis-full text-xs text-muted-foreground" role="status">{refreshed}</p>}
            </div>
          )}
          {state.status === "code" && state.code && (
            <div className="mt-4 space-y-3">
              <CodeDisplay>{state.code}</CodeDisplay>
              <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
                <li>On {phoneOf} phone: WhatsApp › Settings › Linked devices › Link a device.</li>
                <li>Tap &ldquo;Link with phone number instead&rdquo;, then type this code.</li>
              </ol>
              <p className="text-xs text-muted-foreground" role="status">It changes every couple of minutes.{refreshed ? ` ${refreshed}.` : ""}</p>
            </div>
          )}
          {state.status === "starting" && <Waiting>Starting WhatsApp…</Waiting>}
          {state.error && <p className="mt-3 text-sm text-destructive">{state.error}</p>}
          <ActionButton className="mt-4" variant="outline" action={() => unlink({ key: dashboardKey })}>Cancel</ActionButton>
        </div>
      )}

      {linked && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-start gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
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
            <div>
              <h3 className="font-medium">Send this from your own WhatsApp to {state.number ?? "Perry's number"}</h3>
              {state.pairingCode ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <CodeDisplay>{state.pairingCode}</CodeDisplay>
                </div>
              ) : <p className="mt-2 text-sm text-muted-foreground">That code expired.</p>}
              <ActionButton className="mt-3" variant="outline" size="sm" action={() => newCode({ key: dashboardKey })}><RefreshCwIcon />New code</ActionButton>
            </div>
          )}
        </div>
      )}

    </>
  );
}

/**
 * Where Perry's own messages go when you're away: one app, chosen here once
 * both Telegram and WhatsApp are paired. Replies always go where you wrote.
 */
function AwayChannel() {
  const { dashboardKey } = useSession();
  const state = useQuery(api.whatsapp.status, { key: dashboardKey });
  const setHome = useMutation(api.whatsapp.setHomeChannel);
  return (
    <Section title="When you're away" tip="Replies always go where you wrote. Perry's own messages, like the heartbeat and alerts, go to one app.">
      {!state ? <ListSkeleton rows={1} /> : state.paired && state.telegramPaired ? (
        <ChoiceCards label="Where Perry reaches you" value={state.homeChannel}
          options={[
            { value: "telegram", title: "Telegram", icon: <SendIcon /> },
            { value: "whatsapp", title: "WhatsApp", icon: <MessageCircleIcon /> },
          ]}
          onChange={(channel) => void setHome({ key: dashboardKey, channel }).then(() => toast.success(`Perry will reach you on ${channel === "telegram" ? "Telegram" : "WhatsApp"}.`), (cause) => toast.error(errorText(cause)))} />
      ) : (
        <p className="text-sm text-pretty text-muted-foreground">
          {state.paired || state.telegramPaired ? `They go to ${state.paired ? "WhatsApp" : "Telegram"}, the one you've paired. Pair both ` : "Pair "}
          <Link href="/settings/telegram" className="link">Telegram</Link>{state.paired || state.telegramPaired ? " and " : " or "}<Link href="/settings/whatsapp" className="link">WhatsApp</Link>
          {state.paired || state.telegramPaired ? " to choose." : " to get them on your phone."}
        </p>
      )}
    </Section>
  );
}
