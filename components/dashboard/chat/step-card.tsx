"use client";

import { ExternalLinkIcon, FileIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { StepView } from "@/convex/dashboard";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * A step opened: what it ran and printed, the files it changed and how, the
 * page Perry's browser was on, what a search found, or what a tool was given
 * and said (dashboard.getStep). Flat, under the step's line; long text shows
 * a few lines with the rest a click away. Live while the step runs.
 */
export function StepDetail({ id }: { id: string }) {
  const { dashboardKey } = useSession();
  const step = useQuery(api.dashboard.getStep, { key: dashboardKey, id });
  if (step === undefined) return <Skeleton className="h-3.5 w-2/3" role="status" aria-label="Loading" />;
  if (step === null) return null;
  return <div className="min-w-0 space-y-1.5 text-xs" data-step-card={step.kind}><Card step={step} /></div>;
}

function Card({ step }: { step: StepView }) {
  switch (step.kind) {
    case "command":
      return (
        <>
          <Mono className="text-foreground/85">$ {step.command}</Mono>
          {step.output && <Clip text={step.output} lines={6} from="end" cut={step.cut} label="Output" />}
          {step.exit !== undefined && step.exit !== 0 && <p className="text-destructive">Exit code {step.exit}</p>}
        </>
      );
    case "file":
      return (
        <>
          <ul className="flex flex-wrap gap-x-3 gap-y-0.5">
            {step.files.map((file) => (
              <li key={file.path} className="min-w-0">
                {file.url
                  ? <a href={file.url} target="_blank" rel="noreferrer" title={file.path} className="inline-flex max-w-full items-center gap-1 text-foreground underline-offset-2 hover:underline" data-file-link>
                    <FileIcon className="size-3 shrink-0" aria-hidden /><span className="truncate">{file.name}</span>
                  </a>
                  : <span title={file.path} className="inline-flex items-center gap-1 text-foreground"><FileIcon className="size-3 shrink-0" aria-hidden />{file.name}</span>}
              </li>
            ))}
          </ul>
          {step.diff && <Clip text={step.diff} lines={10} from="start" cut={step.cut} label="Changes" diff />}
          {step.error && <Clip text={step.error} lines={4} from="start" cut={false} label="Error" tone="error" />}
        </>
      );
    case "browser": {
      const url = step.url && /^https?:\/\//i.test(step.url) ? step.url : undefined;
      return (
        <>
          {(step.title || url) && (
            <p className="min-w-0 truncate">
              {url ? <External href={url}>{step.title || host(url)}</External> : step.title}
              {url && step.title && <span className="text-muted-foreground"> · {host(url)}</span>}
            </p>
          )}
          {step.picture && (
            <a href={step.picture} target="_blank" rel="noreferrer" className="block w-fit" aria-label="Open the picture of the page">
              {/* eslint-disable-next-line @next/next/no-img-element -- a local file served by /api/media, not a static asset */}
              <img src={step.picture} alt={step.title ? `The page: ${step.title}` : "The page"} loading="lazy" data-step-picture
                className="max-h-56 w-auto max-w-full rounded-md ring-1 ring-border"
                onError={(event) => { event.currentTarget.parentElement!.hidden = true; }} />
            </a>
          )}
          {step.error && <p className="text-destructive">{step.error}</p>}
        </>
      );
    }
    case "search":
      return <SearchResults step={step} />;
    case "tool":
      return (
        <>
          {step.args.length > 0 && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5" data-step-args>
              {step.args.map((arg, index) => (
                <div key={`${arg.key}-${index}`} className="contents">
                  <dt className="text-muted-foreground">{arg.key}</dt>
                  <dd className="truncate font-mono" title={arg.value}>{arg.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {step.result && <Clip text={step.result} lines={4} from="start" cut={step.cut} label="Result" tone={step.error ? "error" : undefined} />}
        </>
      );
  }
}

const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } };

function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1 text-foreground underline-offset-2 hover:underline">
      <span className="truncate">{children}</span><ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
    </a>
  );
}

function SearchResults({ step }: { step: Extract<StepView, { kind: "search" }> }) {
  const [all, setAll] = useState(false);
  const shown = all ? step.results : step.results.slice(0, 3);
  return (
    <>
      {shown.length > 0 && (
        <ul className="space-y-0.5" data-step-results>
          {shown.map((result) => (
            <li key={result.url} className="min-w-0 truncate">
              <External href={result.url}>{result.title || host(result.url)}</External>
              {result.title && <span className="text-muted-foreground"> · {host(result.url)}</span>}
            </li>
          ))}
        </ul>
      )}
      {step.results.length > 3 && <More open={all} onClick={() => setAll(!all)} count={step.results.length} what="results" />}
      {step.error && <p className="text-destructive">{step.error}</p>}
    </>
  );
}

function Mono({ className, children }: { className?: string; children: ReactNode }) {
  return <pre className={cn("font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]", className)}>{children}</pre>;
}

/**
 * Long text, a few lines of it: a command's last lines (how it went), or the
 * first of anything else. "Show all" opens the rest the trace kept; a text the
 * trace cut short says so.
 */
function Clip({ text, lines, from, cut, label, diff, tone }: { text: string; lines: number; from: "start" | "end"; cut: boolean; label: string; diff?: boolean; tone?: "error" }) {
  const [all, setAll] = useState(false);
  const rows = text.replace(/\s+$/, "").split("\n");
  const long = rows.length > lines;
  const shown = all || !long ? rows : from === "end" ? rows.slice(-lines) : rows.slice(0, lines);
  return (
    <div className="min-w-0" data-step-text={label.toLowerCase()} data-clipped={long && !all ? "true" : "false"}>
      <pre aria-label={label} className={cn("font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]", all && long && "max-h-96 overflow-y-auto", tone === "error" ? "text-destructive" : "text-muted-foreground")}>
        {((all || !long) && cut && from === "end") || (long && !all && from === "end") ? <span className="text-muted-foreground/60">…{"\n"}</span> : null}
        {diff ? shown.map((row, index) => (
          <span key={index} className={cn("block", /^\+(?!\+\+)/.test(row) && "text-success", /^-(?!--)/.test(row) && "text-destructive")}>{row || " "}</span>
        )) : shown.join("\n")}
        {((all || !long) && cut && from === "start") || (long && !all && from === "start") ? <span className="text-muted-foreground/60">{"\n"}…</span> : null}
      </pre>
      {long && <More open={all} onClick={() => setAll(!all)} count={rows.length} what="lines" />}
    </div>
  );
}

function More({ open, onClick, count, what }: { open: boolean; onClick: () => void; count: number; what: string }) {
  return (
    <button type="button" onClick={onClick} aria-expanded={open}
      className="mt-0.5 cursor-pointer rounded-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">
      {open ? "Show less" : `Show all ${count} ${what}`}
    </button>
  );
}
