"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Globe, RefreshCw } from "lucide-react";
import { useAction } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Section, StatusBadge } from "../common";
import type { Platform, diagnostics } from "@/convex/lib/internet";

const NAMES: Record<Platform, string> = { web: "Web", github: "GitHub", youtube: "YouTube", rss: "RSS / Atom", reddit: "Reddit", x: "X", instagram: "Instagram", linkedin: "LinkedIn" };

/** Configuration and successful reads are separate facts; unprobed sources never get a ready badge. */
export function Internet() {
  const { dashboardKey } = useSession();
  const getStatus = useAction(api.dashboard.getInternetStatus);
  const [rows, setRows] = useState<ReturnType<typeof diagnostics>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    getStatus({ key: dashboardKey }).then((result) => { if (active) setRows(result); }, () => { if (active) setError("Could not load internet diagnostics."); });
    return () => { active = false; };
  }, [dashboardKey, getStatus]);
  const refresh = async () => {
    setBusy(true); setError(undefined);
    try { setRows(await getStatus({ key: dashboardKey, recheck: true })); }
    catch { setError("Could not refresh internet diagnostics."); }
    finally { setBusy(false); }
  };
  return <Section title="Internet" description="Where Perry can read and search."
    tip="A configured account is not proof of a successful read. Reads in chat verify each operation; refresh rechecks configuration. Public reads need no account. Connected reads use your configured plan; website sign-ins use Perry’s dedicated browser."
    actions={<Button variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}><RefreshCw className={busy ? "animate-spin" : ""} />{busy ? "Refreshing…" : "Refresh"}</Button>}>
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <Link href="/apps/connectors" className="link">Connected accounts</Link>
      <Link href="/settings/logins" className="link">Logins & secrets</Link>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!rows && !error && <p className="text-sm text-muted-foreground">Loading capabilities…</p>}
    <div className="divide-y">{rows && [...new Set(rows.map((r) => r.platform))].map((platform) => {
      const operations = rows.filter((row) => row.platform === platform);
      const verified = operations.filter((row) => row.state === "ready").length;
      return <Collapsible key={platform}>
        <CollapsibleTrigger render={<Button variant="ghost" className="group h-auto w-full justify-start rounded-none px-0 py-4 hover:bg-transparent" />}>
          <Globe className="text-muted-foreground" /><span>{NAMES[platform]}</span>
          <span className="ml-auto text-xs font-normal text-muted-foreground">{verified ? `${verified} verified` : "Not verified"}</span>
          <ChevronRight className="text-muted-foreground transition-transform group-data-panel-open:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent className="pb-4 pl-6">
          <div className="divide-y">{operations.map((row) => <div key={`${row.operation}:${row.backend}`} className="space-y-2 py-3 first:pt-0 last:pb-0 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium capitalize">{row.operation}</span>
              <span className="text-xs text-muted-foreground">{row.access === "public" ? "Public" : "Connected account"}</span>
              <span className="ml-auto"><StatusBadge tone={row.state === "ready" ? "success" : row.state === "unprobed" ? "neutral" : "warning"}>{row.state === "unprobed" ? "Not verified" : row.state.replaceAll("_", " ")}</StatusBadge></span>
            </div>
            {row.failure && <p className="text-muted-foreground">{row.failure.message} {row.failure.repair}</p>}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <dt>Backend</dt><dd className="min-w-0 break-words">{row.selectedBackend ?? `${row.backend} (not verified)`}</dd>
              <dt>Setup</dt><dd>{row.dependency.replaceAll("_", " ")}</dd>
              <dt>Authentication</dt><dd>{row.authentication.replaceAll("_", " ")}</dd>
              {row.fallbackDependency && <><dt>Browser fallback</dt><dd>{row.fallbackDependency.replaceAll("_", " ")} · needs a successful read</dd></>}
              <dt>Last checked</dt><dd>{row.lastProbeAt ? new Date(row.lastProbeAt).toLocaleString() : "Never"}{row.stale ? " · stale; read again to recheck" : ""}</dd>
              <dt>Last success</dt><dd>{row.lastSuccessAt ? new Date(row.lastSuccessAt).toLocaleString() : "Never"}</dd>
            </dl>
          </div>)}</div>
        </CollapsibleContent>
      </Collapsible>;
    })}</div>
  </Section>;
}
