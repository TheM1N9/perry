"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAction } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Section } from "../common";
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
  return <Section title="Internet" description="What Perry can read, operation by operation. A configured account is not proof that a read works.">
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="outline" disabled={busy} onClick={() => void refresh()}>{busy ? "Refreshing…" : "Refresh capabilities"}</Button>
      <Link href="/apps/connectors" className="text-sm underline underline-offset-4">Connected accounts</Link>
      <Link href="/settings/logins" className="text-sm underline underline-offset-4">Logins & secrets</Link>
    </div>
    <p className="text-sm text-muted-foreground">Refresh clears brief account checks. Reads in chat provide operation probes. Public reads use no account; authenticated website interaction uses Perry’s dedicated browser. Connected reads use your configured plan.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!rows && !error && <p className="text-sm text-muted-foreground">Loading capabilities…</p>}
    {rows && [...new Set(rows.map((r) => r.platform))].map((platform) => <details key={platform} className="rounded-lg border p-4">
      <summary className="cursor-pointer font-medium">{NAMES[platform]}</summary>
      <div className="mt-4 grid gap-4">
        {rows.filter((r) => r.platform === platform).map((row) => <div key={`${row.operation}:${row.backend}`} className="grid gap-1 text-sm">
          <p className="font-medium capitalize">{row.operation} · {row.access} · {row.state.replaceAll("_", " ")}</p>
          <p className="text-muted-foreground">Backend: {row.selectedBackend ?? `${row.backend} (not verified)`}. Dependency: {row.dependency.replaceAll("_", " ")}. Authentication: {row.authentication.replaceAll("_", " ")}.</p>
          {row.fallbackDependency && <p className="text-muted-foreground">Public browser fallback: {row.fallbackDependency.replaceAll("_", " ")}. An installed browser still needs a successful read.</p>}
          <p className="text-muted-foreground">Last probe: {row.lastProbeAt ? new Date(row.lastProbeAt).toLocaleString() : "never"}{row.stale ? " (stale; read again to recheck)" : ""}. Last successful read: {row.lastSuccessAt ? new Date(row.lastSuccessAt).toLocaleString() : "never"}.</p>
          {row.failure && <p>{row.failure.message} {row.failure.repair}</p>}
        </div>)}
      </div>
    </details>)}
  </Section>;
}
