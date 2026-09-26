"use client";

import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon } from "lucide-react";
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
              {description && <p className="mt-1.5 max-w-prose text-[15px] text-pretty text-muted-foreground">{description}</p>}
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
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-pretty text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Rows in one bordered block, divided by hairlines. */
export function List({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return <ul aria-label={label} className={cn("divide-y overflow-hidden rounded-xl border bg-card", className)}>{children}</ul>;
}

/** Nothing here yet: a sentence, and the one thing to do about it. */
export function EmptyState({ title, children, action, mascot }: { title: string; children?: ReactNode; action?: ReactNode; mascot?: boolean }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-12 text-center">
      {mascot && <PerryMark className="mb-4 size-14" />}
      <p className="text-[15px] font-medium">{title}</p>
      {children && <p className="mt-1 max-w-sm text-sm text-pretty text-muted-foreground">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A secret field: hidden until asked, never autofilled. */
export function SecretInput({ value, onChange, id, placeholder, autoFocus, invalid, describedBy, name }: {
  value: string; onChange: (value: string) => void; id?: string; placeholder?: string; autoFocus?: boolean;
  invalid?: boolean; describedBy?: string; name?: string;
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
        className="font-mono text-[13px]"
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton size="icon-xs" aria-label={shown ? "Hide" : "Show"} aria-pressed={shown} onClick={() => setShown(!shown)}>
          {shown ? <EyeOffIcon /> : <EyeIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

/** A shell command to copy, in the monospace it will be typed in. */
export function CommandLine({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/60 py-1 pr-1 pl-3 font-mono text-[13px]">
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

/** A short state in a tinted pill: Active, Paused, Needs you. */
export function StatusBadge({ tone = "neutral", children, pulse }: { tone?: Tone; children: ReactNode; pulse?: boolean }) {
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap", TONES[tone])}>
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
      {count !== undefined && count > 0 && <span className="nums rounded-full bg-foreground/8 px-1.5 text-[11px] font-medium text-muted-foreground">{count}</span>}
    </>
  );
}

/** Rows standing in for a list that is still loading. */
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="divide-y rounded-xl border" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="space-y-2 px-4 py-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
