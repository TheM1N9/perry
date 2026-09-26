"use client";

import Link from "next/link";
import { MonitorIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { ComputeView } from "@/convex/dashboard";
import { errorText, plural, useNow } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ApprovalCard } from "../approval-card";
import { ActionButton, CommandLine, EmptyState, List, ListSkeleton, Page, RelativeTime, Section, StatusBadge, type Tone } from "../common";

/**
 * The computers Perry works on. Each one runs Codex for Perry's turns and asks
 * before it acts, as its policy says. Nothing here listens on a port: every
 * runner dials out, so none can be reached from the internet.
 */
export function Computer() {
  const { dashboardKey } = useSession();
  const compute = useQuery(api.dashboard.getCompute, { key: dashboardKey });
  const approvals = useQuery(api.approvals.pending, { key: dashboardKey });
  const now = useNow(1000);
  const [showRevoked, setShowRevoked] = useState(false);
  const live = (approvals ?? []).filter((item) => item.expiresAt > now);

  if (compute === undefined) return <Page title="Computer"><ListSkeleton rows={2} /></Page>;
  const active = compute.runners.filter((runner) => !runner.revoked);
  const revoked = compute.runners.filter((runner) => runner.revoked);

  return (
    <Page title="Computer" description="Where Perry does the work, and what it asks you before it acts. Every computer here dials out; none can be reached from the internet.">
      {live.length > 0 && (
        <Section title="Waiting for you">
          <div className="space-y-3">{live.map((approval) => <ApprovalCard key={approval.id} approval={approval} now={now} />)}</div>
        </Section>
      )}
      <Section title="Computers" description="Perry's own computer connects when Perry starts. Add another from its terminal.">
        {active.length === 0
          ? (
            <EmptyState title={compute.runners.length ? "Every computer here was revoked" : "No computer connected"}
              action={<div className="w-[min(360px,80vw)]"><CommandLine>perry start</CommandLine></div>}>
              Start Perry on the computer you want it to use.
            </EmptyState>
          )
          : <List label="Computers">{[...active, ...(showRevoked ? revoked : [])].map((runner) => <RunnerRow key={runner.id} runner={runner} />)}</List>}
        {revoked.length > 0 && active.length > 0 && (
          <Button variant="link" size="sm" className="mt-2 px-0 text-muted-foreground" aria-expanded={showRevoked} onClick={() => setShowRevoked(!showRevoked)}>
            {showRevoked ? "Hide revoked computers" : `Show ${plural(revoked.length, "revoked computer")}`}
          </Button>
        )}
      </Section>
      <Rules telegram={compute.telegramApprovals} />
      <Recent />
    </Page>
  );
}

function RunnerRow({ runner }: { runner: ComputeView["runners"][number] }) {
  const { dashboardKey } = useSession();
  const revoke = useMutation(api.dashboard.revokeRunner);
  const state: { tone: Tone; label: string } = runner.revoked ? { tone: "danger", label: "Revoked" } : runner.online ? { tone: "success", label: "Online" } : { tone: "neutral", label: "Offline" };

  return (
    <li className={cn("flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-start", runner.revoked && "opacity-60")}>
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted max-sm:hidden" aria-hidden><MonitorIcon className="size-5 text-muted-foreground" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-medium">{runner.name}</h3>
          <StatusBadge tone={state.tone} pulse={runner.online}>{state.label}</StatusBadge>
        </div>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>{runner.platform ?? "Unknown system"}</span>
          {runner.workdir && <span className="max-w-full truncate font-mono text-xs leading-5" title={runner.workdir}>{runner.workdir}</span>}
          {runner.lastSeenAt && <span>Seen <RelativeTime at={runner.lastSeenAt} /></span>}
        </p>
        {!runner.revoked && !runner.online && <p className="mt-1 text-sm text-muted-foreground">Start it again with <code className="font-mono text-xs">perry start</code> on that computer.</p>}
        {!runner.revoked && (
          <p className="mt-2 text-xs text-muted-foreground">
            Whether it asks before acting is set per chat: Ask, Auto or Full access, from the chat&apos;s composer or <Link href="/settings" className="underline underline-offset-2 hover:text-foreground">Settings</Link> for new chats.
          </p>
        )}
      </div>
      {!runner.revoked && (
        <ActionButton variant="ghost" size="sm" className="shrink-0 text-muted-foreground hover:text-destructive" action={() => revoke({ key: dashboardKey, runnerId: runner.id })} success={`${runner.name} can no longer run anything.`}
          confirm={{ title: `Revoke ${runner.name}?`, body: "Its next request is refused and it stops getting work. To use it again, connect it again.", label: "Revoke" }}>
          Revoke
        </ActionButton>
      )}
    </li>
  );
}

function Rules({ telegram }: { telegram: ComputeView["telegramApprovals"] }) {
  const { dashboardKey } = useSession();
  const rules = useQuery(api.approvals.rules, { key: dashboardKey });
  const deleteRule = useMutation(api.approvals.deleteRule);
  const setTelegram = useMutation(api.dashboard.setTelegramApprovals).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.dashboard.getCompute, { key: args.key });
    if (current) store.setQuery(api.dashboard.getCompute, { key: args.key }, { ...current, telegramApprovals: { ...current.telegramApprovals, enabled: args.enabled } });
  });

  return (
    <Section title="Always allowed" description="Saved when you answer with Always allow; a matching request runs without asking. A decline is never remembered.">
      {telegram.ownerOnTelegram && (
        <label className="mb-3 flex cursor-pointer items-start justify-between gap-4 rounded-xl border bg-card px-4 py-3.5">
          <span className="grid gap-0.5">
            <span className="text-sm font-medium">Ask me on Telegram too</span>
            <span className="text-sm text-muted-foreground">Requests arrive there with Approve, Decline and Always allow.</span>
          </span>
          <Switch checked={telegram.enabled} onCheckedChange={(enabled) => void setTelegram({ key: dashboardKey, enabled })
            .then(() => toast.success(enabled ? "Requests come to Telegram too." : "Requests stay in the dashboard and terminal."), (cause) => toast.error(errorText(cause)))} />
        </label>
      )}
      {rules === undefined && <ListSkeleton rows={2} />}
      {rules?.length === 0 && <EmptyState title="No saved rules">Answer a request with Always allow, and the rule shows up here.</EmptyState>}
      {rules && rules.length > 0 && (
        <List label="Rules">
          {rules.map((rule) => (
            <li key={rule.id} className="flex items-start gap-4 px-4 py-3.5">
              <div className="min-w-0 flex-1">
                {rule.command && <code className="block max-h-28 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-[12.5px] whitespace-pre-wrap [overflow-wrap:anywhere]">{rule.command}</code>}
                <p className="mt-1.5 text-sm text-pretty">{rule.description}</p>
                <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span>{rule.runner}</span>
                  <span className="nums">Used {plural(rule.uses, "time")}</span>
                  {rule.lastUsedAt && <span>last <RelativeTime at={rule.lastUsedAt} /></span>}
                </p>
              </div>
              <ActionButton variant="ghost" size="icon-sm" aria-label="Delete rule" className="shrink-0 text-muted-foreground hover:text-destructive" action={() => deleteRule({ key: dashboardKey, id: rule.id })} success="Rule deleted. Matching requests ask again."
                confirm={{ title: "Delete this rule?", body: "Matching requests will ask for approval again.", label: "Delete" }}>
                <Trash2Icon />
              </ActionButton>
            </li>
          ))}
        </List>
      )}
    </Section>
  );
}

const BY: Record<string, string> = {
  terminal: "You, in the terminal",
  dashboard: "You, here",
  telegram: "You, on Telegram",
  timeout: "Nobody answered in time",
  rule: "A saved rule",
  reviewer: "The reviewer",
  trust: "Trusted computer",
};
const STATUS: Record<string, { tone: Tone; label: string }> = {
  approved: { tone: "success", label: "Approved" },
  auto: { tone: "success", label: "Allowed" },
  declined: { tone: "danger", label: "Declined" },
  expired: { tone: "warning", label: "Expired" },
};

function Recent() {
  const { dashboardKey } = useSession();
  const recent = useQuery(api.approvals.recent, { key: dashboardKey });
  return (
    <Section title="Recent requests" description="Everything a computer asked to do, and who let it or stopped it.">
      {recent === undefined && <ListSkeleton rows={2} />}
      {recent?.length === 0 && <EmptyState title="No requests yet">When a computer asks before acting, the answer is recorded here.</EmptyState>}
      {recent && recent.length > 0 && (
        <List label="Recent requests">
          {recent.map((item) => {
            const status = STATUS[item.status] ?? { tone: "neutral" as Tone, label: item.status };
            return (
              <li key={item.id} className="flex items-start gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <code className="block truncate font-mono text-[12.5px]" title={item.title}>{item.title}</code>
                  <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    <span>{item.runner}</span>
                    <RelativeTime at={item.createdAt} />
                    {item.decidedBy && <span>{BY[item.decidedBy] ?? item.decidedBy}</span>}
                  </p>
                  {item.review && <p className="mt-1 text-xs text-pretty text-muted-foreground">Reviewer: {item.review.verdict}. {item.review.reason}</p>}
                </div>
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              </li>
            );
          })}
        </List>
      )}
    </Section>
  );
}
