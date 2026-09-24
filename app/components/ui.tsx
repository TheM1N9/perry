"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

/** The small primitives every page is built from, so they all look and behave alike. */

const paths = {
  plus: "M12 5v14M5 12h14",
  search: "m21 21-4.35-4.35M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
  chat: "M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-9.5A7.5 7.5 0 0 1 10.5 4h2A7.5 7.5 0 0 1 20 11.5Z",
  branch: "M7 4v9a5 5 0 0 0 5 5h5M7 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM19 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM7 13a5 5 0 0 0 5-5h5",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3",
  pencil: "m4 20 4.5-1 10.8-10.8-3.5-3.5L5 15.5 4 20ZM14.7 5.3l3.5 3.5",
  menu: "M4 7h16M4 12h16M4 17h16",
  arrow: "M12 19V5m-6 6 6-6 6 6",
  arrowDown: "M12 5v14m6-6-6 6-6-6",
  close: "M6 6l12 12M18 6 6 18",
  paperclip: "m21.4 11.6-8.8 8.8a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 1 1-2.8-2.8l8.5-8.5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  lock: "M5 10h14v11H5V10Zm3 0V7a4 4 0 0 1 8 0v3",
  chevron: "m9 18 6-6-6-6",
  stop: "M7 7h10v10H7z",
  redo: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  check: "m5 12 5 5L20 7",
  work: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  computer: "M3 5h18v11H3zM8 20h8M12 16v4",
  plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4",
  memory: "M6 3h12v18l-6-4-6 4V3Z",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  settings: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
  key: "M15 7a4 4 0 1 1-3.9 4.9L4 19v2h3v-2h2v-2h2l1.1-1.1A4 4 0 0 1 15 7Zm1 1.5h.01",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2",
  refresh: "M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4",
  alert: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  play: "M7 5v14l11-7L7 5Z",
  pause: "M8 5v14M16 5v14",
  info: "M12 16v-5M12 8h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0",
} as const;
export type IconName = keyof typeof paths;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

export function errorText(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  // Convex prefixes server errors with request metadata nobody needs to read.
  return text.replace(/^\[CONVEX [^\]]*\]\s*/, "").replace(/^\[Request ID: [^\]]*\]\s*/, "").replace(/^Server Error\s*/, "").replace(/^Uncaught Error:\s*/, "").split("\n    at ")[0].trim();
}

/** The current time, refreshed on an interval so relative times stay true. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
export function ago(timestamp: number, now = Date.now()): string {
  const seconds = Math.round((timestamp - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return seconds <= 0 ? "just now" : "in a moment";
  if (abs < 3600) return relative.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), "hour");
  if (abs < 86_400 * 30) return relative.format(Math.round(seconds / 86_400), "day");
  return new Date(timestamp).toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function fullDate(timestamp: number, timeZone?: string) {
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone });
}

/** A relative time that stays fresh, with the exact time on hover. */
export function RelativeTime({ at, prefix = "" }: { at?: number; prefix?: string }) {
  const now = useNow();
  if (!at) return <span>{prefix}never</span>;
  return <time dateTime={new Date(at).toISOString()} title={fullDate(at)}>{prefix}{ago(at, now)}</time>;
}

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

/** A status is always a word as well as a color. */
export function Status({ tone = "neutral", children, pulse }: { tone?: Tone; children: ReactNode; pulse?: boolean }) {
  return <span className={`status status-${tone}${pulse ? " pulse" : ""}`}><span className="status-dot" aria-hidden="true" />{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

/** A titled block on a workspace page. */
export function Section({ title, description, count, actions, children, id, plain }: {
  title: ReactNode;
  description?: ReactNode;
  count?: number;
  actions?: ReactNode;
  children?: ReactNode;
  id?: string;
  /** Lay the children out bare instead of in a bordered card. */
  plain?: boolean;
}) {
  const headingId = useId();
  return <section className="section" aria-labelledby={headingId} id={id}>
    <header className="section-head">
      <div className="section-title">
        <h2 id={headingId}>{title}{count !== undefined && <span className="section-count">{count}</span>}</h2>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="section-actions">{actions}</div>}
    </header>
    {children !== undefined && children !== null && children !== false && <div className={plain ? "section-body plain" : "section-body"}>{children}</div>}
  </section>;
}

export function Empty({ title, children, action, icon }: { title: ReactNode; children?: ReactNode; action?: ReactNode; icon?: IconName }) {
  return <div className="empty">
    {icon && <span className="empty-icon"><Icon name={icon} size={18} /></span>}
    <strong>{title}</strong>
    {children && <p>{children}</p>}
    {action && <div className="empty-action">{action}</div>}
  </div>;
}

export function Loading({ label = "Loading…", rows = 3 }: { label?: string; rows?: number }) {
  return <div className="loading" role="status" aria-live="polite">
    <span className="sr-only">{label}</span>
    {Array.from({ length: rows }, (_, index) => <div className="skeleton-row" key={index} aria-hidden="true"><span className="skeleton" style={{ width: `${62 - index * 14}%` }} /><span className="skeleton short" /></div>)}
  </div>;
}

/** A message with an optional technical detail tucked behind a disclosure. */
export function Notice({ tone = "neutral", title, children, details, onDismiss, action }: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  details?: string;
  onDismiss?: () => void;
  action?: ReactNode;
}) {
  return <div className={`notice notice-${tone}`} role={tone === "danger" ? "alert" : "status"}>
    <Icon name={tone === "danger" || tone === "warning" ? "alert" : tone === "success" ? "check" : "info"} size={15} />
    <div className="notice-body">
      {title && <strong>{title}</strong>}
      {children && <div className="notice-text">{children}</div>}
      {details && <details className="notice-details"><summary>Technical details</summary><pre>{details}</pre></details>}
      {action && <div className="notice-action">{action}</div>}
    </div>
    {onDismiss && <button type="button" className="icon-button sm" aria-label="Dismiss" onClick={onDismiss}><Icon name="close" size={14} /></button>}
  </div>;
}

export function CopyButton({ value, label = "Copy", className = "btn btn-ghost btn-sm", iconOnly }: { value: string; label?: string; className?: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <button type="button" className={iconOnly ? "icon-button sm" : className} aria-label={iconOnly ? label : undefined} title={iconOnly ? label : undefined}
    onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true), () => toast({ tone: "danger", text: "The browser did not allow copying. Select the text and copy it instead." }))}>
    <Icon name={copied ? "check" : "copy"} size={14} />{!iconOnly && <span>{copied ? "Copied" : label}</span>}
    <span className="sr-only" aria-live="polite">{copied ? "Copied" : ""}</span>
  </button>;
}

/** A terminal command to copy. */
export function Command({ children }: { children: string }) {
  return <div className="command"><code translate="no">{children}</code><CopyButton value={children} iconOnly label="Copy command" /></div>;
}

/**
 * A modal on the native <dialog>, which already traps focus, closes on Escape
 * and hands focus back to whatever opened it.
 */
export function Dialog({ title, description, children, onClose, className = "", role }: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  onClose: () => void;
  className?: string;
  role?: "alertdialog";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closing = useRef(onClose);
  closing.current = onClose;
  const titleId = useId();
  const descriptionId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    // The close event is queued, so one from an earlier close can land after
    // the dialog was shown again (Strict Mode remounts do this); ignore it.
    const onCloseEvent = () => { if (!dialog.open) closing.current(); };
    dialog.addEventListener("close", onCloseEvent);
    return () => {
      dialog.removeEventListener("close", onCloseEvent);
      if (dialog.open) dialog.close();
    };
  }, []);
  return <dialog ref={ref} className={`dialog ${className}`} role={role} aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
    onMouseDown={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
    <div className="dialog-inner">
      <h2 id={titleId} className="dialog-title">{title}</h2>
      {description && <p id={descriptionId} className="dialog-description">{description}</p>}
      {children}
    </div>
  </dialog>;
}

type Confirm = { title: string; body: ReactNode; confirmLabel: string; danger?: boolean };

/**
 * A button for anything that talks to the server: it shows progress, cannot be
 * pressed twice, reports failure, and asks first when the action is destructive.
 */
export function ActionButton({ action, children, pendingLabel, success, confirm, variant = "secondary", size = "sm", icon, className = "", disabled, ...rest }: {
  action: () => Promise<unknown>;
  children: ReactNode;
  pendingLabel?: string;
  success?: string | ((result: unknown) => string | undefined);
  confirm?: Confirm;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  icon?: IconName;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children">) {
  const [pending, setPending] = useState(false);
  const [asking, setAsking] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const toast = useToast();
  const run = async (fromDialog: boolean) => {
    setPending(true);
    setDialogError("");
    try {
      const result = await action();
      const text = typeof success === "function" ? success(result) : success;
      if (text) toast({ tone: "success", text });
      if (fromDialog) setAsking(false);
    } catch (cause) {
      if (fromDialog) setDialogError(errorText(cause));
      else toast({ tone: "danger", text: errorText(cause) });
    } finally {
      setPending(false);
    }
  };
  return <>
    <button type="button" className={`btn btn-${variant} btn-${size} ${className}`} disabled={disabled || pending} aria-busy={pending || undefined} {...rest}
      onClick={() => confirm ? setAsking(true) : void run(false)}>
      {pending ? <Spinner /> : icon ? <Icon name={icon} size={14} /> : null}
      <span>{pending && pendingLabel ? pendingLabel : children}</span>
    </button>
    {asking && confirm && <Dialog title={confirm.title} description={confirm.body} role="alertdialog" onClose={() => { if (!pending) setAsking(false); }}>
      {dialogError && <Notice tone="danger">{dialogError}</Notice>}
      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary btn-md" onClick={() => setAsking(false)} disabled={pending} autoFocus>Cancel</button>
        <button type="button" className={`btn btn-${confirm.danger === false ? "primary" : "danger"} btn-md`} onClick={() => void run(true)} disabled={pending} aria-busy={pending || undefined}>
          {pending && <Spinner />}{confirm.confirmLabel}
        </button>
      </div>
    </Dialog>}
  </>;
}

/** A password-style field that can be revealed, for keys you paste in. */
export function SecretInput({ value, onChange, placeholder, id, name, onEnter, autoFocus, invalid, describedBy }: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  name?: string;
  onEnter?: () => void;
  autoFocus?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [shown, setShown] = useState(false);
  return <div className="input-group">
    <input id={id} name={name} className="input" type={shown ? "text" : "password"} value={value} placeholder={placeholder} autoComplete="off" spellCheck={false} autoFocus={autoFocus}
      aria-invalid={invalid || undefined} aria-describedby={describedBy}
      onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && onEnter) { event.preventDefault(); onEnter(); } }} />
    <button type="button" className="icon-button" aria-label={shown ? "Hide value" : "Show value"} aria-pressed={shown} onClick={() => setShown(!shown)}><Icon name={shown ? "eyeOff" : "eye"} size={15} /></button>
  </div>;
}

type Toast = { id: number; tone: Tone; text: string };
const ToastContext = createContext<(toast: Omit<Toast, "id">) => void>(() => {});
export const useToast = () => useContext(ToastContext);

/** Short confirmations and failures for actions, announced to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((items) => items.filter((item) => item.id !== id)), []);
  const show = useCallback((toast: Omit<Toast, "id">) => {
    const id = ++next.current;
    setToasts((items) => [...items.slice(-3), { ...toast, id }]);
    window.setTimeout(() => dismiss(id), toast.tone === "danger" ? 9000 : 4000);
  }, [dismiss]);
  return <ToastContext.Provider value={show}>
    {children}
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => <div key={toast.id} className={`toast toast-${toast.tone}`}>
        <Icon name={toast.tone === "danger" ? "alert" : "check"} size={15} />
        <span>{toast.text}</span>
        <button type="button" className="icon-button sm" aria-label="Dismiss" onClick={() => dismiss(toast.id)}><Icon name="close" size={13} /></button>
      </div>)}
    </div>
  </ToastContext.Provider>;
}
