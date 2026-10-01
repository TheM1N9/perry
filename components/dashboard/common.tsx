"use client";

import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon, InfoIcon, MessageCircleIcon, SendIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ago, copyText, errorText, fullDate, useNow } from "@/lib/format";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PlatypusArt } from "./platypus";

/** Perry's face: the logo, and the mark on empty states. */
export function PerryMark({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn("grid shrink-0 place-items-center overflow-hidden rounded-full bg-brand-soft", className)}>
      <PlatypusArt head className="w-[92%] translate-y-[6%]" />
    </span>
  );
}

/** The owner's messaging apps, as a chat in the web app is marked. */
export const APPS = { telegram: "Telegram", whatsapp: "WhatsApp" } as const;

/** Which app a Telegram or WhatsApp chat is in; nothing for a web chat. */
export function ChannelIcon({ channel, className }: { channel: "web" | "telegram" | "whatsapp"; className?: string }) {
  if (channel === "web") return null;
  const Icon = channel === "telegram" ? SendIcon : MessageCircleIcon;
  return <Icon role="img" aria-label={APPS[channel]} className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />;
}

/** Copy with a brief check, and a toast when the browser refuses. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>(undefined);
  const copy = useCallback((text: string) => {
    copyText(text).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    }, (cause) => toast.error(`Couldn't copy: ${errorText(cause)}`));
  }, []);
  return { copied, copy };
}

/**
 * An ⓘ that explains a choice on hover or focus, so a menu can list just the
 * names. Screen readers get the explanation with the name.
 */
export function InfoTip({ children, className }: { children: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} />} className={cn("inline-grid size-4 shrink-0 cursor-help place-items-center rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", className)}
        aria-label={children} onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
        <InfoIcon className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-pretty">{children}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Words that say more on hover or focus: a time's full date, a cron behind its
 * reading, the rest of a cut-off path. The tip is in the words for screen
 * readers too (`spoken`, when it adds to them). Its popup is data-solid, for
 * the pet's window, which takes the pointer only there.
 */
export function TextTip({ tip, spoken, children, className }: { tip: ReactNode; spoken?: string; children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} />} className={cn("min-w-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50", className)}>
        {children}{spoken && <span className="sr-only">{` (${spoken})`}</span>}
      </TooltipTrigger>
      <TooltipContent data-solid className="max-w-80 text-pretty [overflow-wrap:anywhere]">{tip}</TooltipContent>
    </Tooltip>
  );
}

/** A code to read off the screen and type elsewhere (a sign-in or pairing code): big, spaced monospace, and a button that copies it. */
export function CodeDisplay({ children, label, className, ...props }: { children: string; label?: string; className?: string } & ComponentProps<"span">) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span translate="no" aria-label={label} className="font-mono text-2xl font-semibold tracking-[0.2em] sm:text-3xl" {...props}>{children}</span>
      <CopyButton value={children} label="Copy code" />
    </span>
  );
}

export function CopyButton({ value, label = "Copy", className, size = "icon-sm" }: {
  value: string; label?: string; className?: string; size?: "icon-xs" | "icon-sm" | "icon";
}) {
  const { copied, copy } = useCopy();
  return (
    <Tooltip>
      <TooltipTrigger render={<Button type="button" variant="ghost" size={size} className={cn("text-muted-foreground", className)} aria-label={copied ? "Copied" : label} onClick={() => copy(value)} />}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}

/** A time as "5 min. ago", with the full date on hover. */
export function RelativeTime({ at, className }: { at: number; className?: string }) {
  const now = useNow();
  return (
    <time dateTime={new Date(at).toISOString()} title={fullDate(at)} className={cn("nums", className)}>
      {ago(at, now)}
    </time>
  );
}

/** The bar across the top of a page: the sidebar toggle, and where you are. */
export function TopBar({ children, actions }: { children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b border-transparent bg-background/85 px-3 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
      <SidebarTrigger className="text-muted-foreground" />
      <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">{children}</div>
      {actions && <div className="flex items-center gap-1">{actions}</div>}
    </header>
  );
}

/** A page: its top bar, then a readable column with a title. */
export function Page({ title, description, actions, children, wide }: {
  title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; wide?: boolean;
}) {
  return (
    <>
      <TopBar />
      <main id="content" tabIndex={-1} className="flex-1 outline-none">
        <div className={cn("mx-auto w-full px-4 pb-24 pt-4 sm:px-8 sm:pt-8", wide ? "max-w-5xl" : "max-w-3xl")}>
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-[-0.02em] text-balance">{title}</h1>
              {description && <p className="mt-1.5 max-w-prose text-md text-pretty text-muted-foreground">{description}</p>}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          </div>
          {children}
        </div>
      </main>
    </>
  );
}

/** A titled group of rows on a page. */
export function Section({ title, description, actions, children, className }: {
  title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={cn("mt-10 first:mt-0", className)} aria-label={title}>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-md font-semibold tracking-[-0.01em]">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * Rows on the page, divided by hairlines and nothing else: no box around them,
 * so each row lines up with the section's title above it.
 */
export function List({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return <ul aria-label={label} className={cn("divide-y *:px-0", className)}>{children}</ul>;
}

/**
 * Nothing here yet: what is missing, a sentence, and the one thing to do
 * about it, laid on the page like the rest. With `mascot`, for a page that is
 * empty as a whole: Perry, centred, as the pet's empty tabs have him.
 */
export function EmptyState({ title, children, action, mascot }: { title: string; children?: ReactNode; action?: ReactNode; mascot?: boolean }) {
  if (mascot) {
    return (
      <div className="flex flex-col items-center px-6 py-12 text-center" data-empty>
        <PerryMark className="mb-4 size-14" />
        <p className="text-md font-medium">{title}</p>
        {children && <p className="mt-1 max-w-sm text-sm text-pretty text-muted-foreground">{children}</p>}
        {action && <div className="mt-4">{action}</div>}
      </div>
    );
  }
  return (
    <div className="py-1" data-empty>
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="mt-0.5 max-w-prose text-sm text-pretty text-muted-foreground">{children}</p>}
      {action && <div className="mt-3 max-w-md">{action}</div>}
    </div>
  );
}

/**
 * A secret field: hidden until asked, never autofilled. With `save`, it keeps
 * its own quiet Save inside, there only once something is typed: a key is
 * stored when you say so (that or Enter, which submits its form), never half
 * typed.
 */
export function SecretInput({ value, onChange, id, placeholder, autoFocus, invalid, describedBy, name, save }: {
  value: string; onChange: (value: string) => void; id?: string; placeholder?: string; autoFocus?: boolean;
  invalid?: boolean; describedBy?: string; name?: string;
  save?: { label?: string; busy?: boolean };
}) {
  const [shown, setShown] = useState(false);
  return (
    <InputGroup className="h-10">
      <InputGroupInput
        id={id}
        name={name}
        type={shown ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className="font-mono text-sm"
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton size="icon-xs" aria-label={shown ? "Hide" : "Show"} aria-pressed={shown} onClick={() => setShown(!shown)}>
          {shown ? <EyeOffIcon /> : <EyeIcon />}
        </InputGroupButton>
        {save && (value.trim() || save.busy) && (
          <InputGroupButton type="submit" size="xs" className="text-primary hover:text-primary" disabled={save.busy} aria-busy={save.busy || undefined}>
            {save.busy && <Spinner />}{save.label ?? "Save"}
          </InputGroupButton>
        )}
      </InputGroupAddon>
    </InputGroup>
  );
}

/** A shell command to copy, in the monospace it will be typed in. */
export function CommandLine({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/60 py-1 pr-1 pl-3 font-mono text-sm" data-command-line>
      <span className="select-none text-muted-foreground">$</span>
      <code className="min-w-0 flex-1 truncate">{children}</code>
      <CopyButton value={children} label="Copy command" size="icon-xs" />
    </div>
  );
}

/** Run an async action with a toast for the outcome. Returns whether it worked. */
export async function attempt(action: () => Promise<unknown>, messages: { success?: string; error?: string } = {}): Promise<boolean> {
  try {
    await action();
    if (messages.success) toast.success(messages.success);
    return true;
  } catch (cause) {
    toast.error(messages.error ? `${messages.error}: ${errorText(cause)}` : errorText(cause));
    return false;
  }
}

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";
const TONES: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success/12 text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-destructive/10 text-destructive",
  info: "bg-brand-soft text-primary",
};

/**
 * A short state. Only what wants a look gets a tinted pill: a warning, a
 * failure, something that needs you, or work going on now (`pulse`). Anything
 * else (Paused, Signed in, a plan's name) is a few muted words, and a row that
 * is simply fine is better off saying nothing.
 */
export function StatusBadge({ tone = "neutral", children, pulse }: { tone?: Tone; children: ReactNode; pulse?: boolean }) {
  if (!pulse && tone !== "warning" && tone !== "danger") {
    return <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground" data-status={tone}>{children}</span>;
  }
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap", TONES[tone])} data-status={tone} data-pill>
      {pulse && <span className="size-1.5 rounded-full bg-current motion-safe:animate-pulse" aria-hidden />}
      {children}
    </span>
  );
}

type ButtonProps = Omit<ComponentProps<typeof Button>, "onClick" | "children">;

/**
 * A button that runs something on the server: busy while it runs, a toast for
 * how it went, and for anything that can't be undone, a question first.
 */
export function ActionButton({ action, success, error, confirm, children, ...props }: ButtonProps & {
  action: () => Promise<unknown>;
  success?: string;
  error?: string;
  confirm?: { title: string; body: ReactNode; label: string };
  children: ReactNode;
}) {
  const [running, setRunning] = useState(false);
  const [asking, setAsking] = useState(false);
  const run = async () => {
    setAsking(false);
    setRunning(true);
    await attempt(action, { success, error });
    setRunning(false);
  };
  return (
    <>
      <Button {...props} disabled={props.disabled || running} aria-busy={running || undefined} onClick={() => confirm ? setAsking(true) : void run()}>
        {running && <Spinner />}{children}
      </Button>
      {confirm && (
        <AlertDialog open={asking} onOpenChange={setAsking}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
              <AlertDialogDescription>{confirm.body}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep it</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => void run()}>{confirm.label}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}

/** A value kept in the address, like a tab or a filter, so it survives a reload and can be linked to. */
export function useSearchParam(name: string, fallback: string): [string, (value: string) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const value = params.get(name) ?? fallback;
  const set = (next: string) => {
    const query = new URLSearchParams(params);
    if (next === fallback) query.delete(name);
    else query.set(name, next);
    const search = query.toString();
    router.replace(`${pathname}${search ? `?${search}` : ""}`, { scroll: false });
  };
  return [value, set];
}

/** A page's tab, as ?tab=. */
export function useTab<T extends string>(tabs: readonly T[], fallback: T): [T, (tab: T) => void] {
  const [asked, set] = useSearchParam("tab", fallback);
  return [(tabs as readonly string[]).includes(asked) ? asked as T : fallback, set];
}

/** A tab's label with how many are in it. */
export function TabCount({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <>
      {children}
      {count !== undefined && count > 0 && <span className="nums font-normal text-muted-foreground">{count}</span>}
    </>
  );
}

/** Rows standing in for a list that is still loading. */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="divide-y" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="space-y-2 py-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
