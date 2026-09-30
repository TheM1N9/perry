"use client";

import Link from "next/link";
import { MessageSquarePlusIcon, PuzzleIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAction } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { SkillView } from "@/convex/skills";
import { errorText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Markdown } from "../chat/markdown";
import { ActionButton, CopyButton, EmptyState, List, ListSkeleton, Page, StatusBadge, useSearchParam } from "../common";

type SkillRead = SkillView & { path: string; skill: string; files: Array<{ path: string; bytes: number }> };

/**
 * The skills in Perry's skills folder. They are files on this computer, not
 * rows the dashboard is told about when they change, so they are read when
 * asked: when a page opens, on Refresh, and when the composer starts a $.
 */
export function useSkills() {
  const { dashboardKey } = useSession();
  const listSkills = useAction(api.skills.list);
  const [skills, setSkills] = useState<SkillView[] | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setSkills(await listSkills({ key: dashboardKey }));
      setError("");
    } catch (cause) {
      setError(errorText(cause));
      setSkills((current) => current ?? []);
    }
  }, [dashboardKey, listSkills]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { skills, error, refresh };
}

const addedOn = (at: number) => new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });
/** Where a skill came from, in a few words: the site or folder it was imported from, or Perry. */
function origin(skill: SkillView): string {
  if (!skill.source) return "Written by Perry";
  try {
    const url = new URL(skill.source);
    if (url.protocol === "http:" || url.protocol === "https:") return `Imported from ${url.hostname}${url.hostname === "github.com" ? url.pathname.split("/").slice(0, 3).join("/") : ""}`;
  } catch {}
  return `Imported from ${skill.source}`;
}
/** A SKILL.md to read: its frontmatter as the YAML it is, then the rest as Markdown. */
const readable = (skill: string) => skill.replace(/^﻿?---\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(\r?\n|$)/, (_, yaml: string) => `\`\`\`yaml\n${yaml}\n\`\`\`\n\n`);
const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;

/**
 * Skills: instructions for particular kinds of work, one folder each with a
 * SKILL.md, in the folder every engine is pointed at. Perry writes one when
 * the owner tells him how they like something done, and imports someone
 * else's on their yes (review_skill, install_skill). Here the owner sees
 * them, reads one, and removes one; "$name" in a chat uses one.
 */
export function Skills() {
  const { dashboardKey } = useSession();
  const { skills, error, refresh } = useSkills();
  const removeSkill = useAction(api.skills.remove);
  const [refreshing, setRefreshing] = useState(false);
  // The skill open, by name, in the address: a "$name" in a chat links here.
  const [open, setOpen] = useSearchParam("skill", "");
  const opened = skills?.find((skill) => skill.name === open) ?? skills?.find((skill) => skill.folder === open);

  const remove = async (skill: SkillView) => {
    await removeSkill({ key: dashboardKey, folder: skill.folder });
    if (open) setOpen("");
    await refresh();
  };
  const refreshButton = (
    <Button variant="outline" size="sm" disabled={refreshing} aria-busy={refreshing || undefined}
      onClick={() => { setRefreshing(true); void refresh().finally(() => setRefreshing(false)); }}>
      {refreshing ? <Spinner /> : <RefreshCwIcon />}Refresh
    </Button>
  );

  return (
    <Page title="Skills" actions={refreshButton}
      description={<>How Perry does particular kinds of work. He writes a skill when you tell him how you like something done, and imports someone else&apos;s once you say yes. Type <kbd className="rounded border bg-muted px-1 font-mono text-[13px]">$</kbd> in a chat to use one.</>}>
      {error && <Alert variant="destructive" className="mb-6"><TriangleAlertIcon /><AlertTitle>Couldn&apos;t read the skills folder</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {skills === null ? <ListSkeleton /> : skills.length === 0 ? (
        <EmptyState title="No skills yet" mascot>
          Tell Perry how you like something done (&ldquo;from now on, write my weekly review like this&rdquo;), or give him the address of a skill to look over and install.
        </EmptyState>
      ) : (
        <List label="Skills">
          {skills.map((skill) => (
            <li key={skill.folder} className="flex items-start gap-3 px-4 py-3" data-skill={skill.name}>
              <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-full border bg-background text-muted-foreground" aria-hidden><PuzzleIcon className="size-4" /></span>
              <button type="button" className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setOpen(skill.name)}>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[14px] font-medium">{skill.name}</span>
                  {skill.problem && <StatusBadge tone="warning">Not loaded</StatusBadge>}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-sm text-pretty text-muted-foreground">{skill.description || skill.problem}</span>
                <span className="mt-1 block truncate text-xs text-muted-foreground" title={skill.source}>{origin(skill)} · Added {addedOn(skill.addedAt)}</span>
              </button>
              <RemoveButton skill={skill} onRemove={() => remove(skill)} />
            </li>
          ))}
        </List>
      )}
      <SkillDialog skill={opened ?? null} onClose={() => setOpen("")} onRemove={remove} />
    </Page>
  );
}

function RemoveButton({ skill, onRemove }: { skill: SkillView; onRemove: () => Promise<unknown> }) {
  return (
    <ActionButton variant="ghost" size="sm" className="shrink-0 text-muted-foreground hover:text-destructive" action={onRemove}
      success={`${skill.name} removed. Perry no longer has it.`}
      confirm={{
        title: `Remove ${skill.name}?`,
        body: <>Its folder is deleted from this computer, and Perry stops using it from the next message. {skill.source ? "You can import it again from where it came from." : "Perry wrote it, so it cannot be got back unless you have a copy."}</>,
        label: "Remove",
      }}>
      Remove
    </ActionButton>
  );
}

/** One skill: where it came from, its SKILL.md, and what else is in its folder. */
function SkillDialog({ skill, onClose, onRemove }: { skill: SkillView | null; onClose: () => void; onRemove: (skill: SkillView) => Promise<unknown> }) {
  const { dashboardKey } = useSession();
  const readSkill = useAction(api.skills.read);
  const [read, setRead] = useState<{ folder: string; skill?: SkillRead; error?: string } | null>(null);
  const folder = skill?.folder;
  useEffect(() => {
    if (!folder) return;
    let current = true;
    readSkill({ key: dashboardKey, folder }).then(
      (found) => { if (current) setRead({ folder, skill: found }); },
      (cause) => { if (current) setRead({ folder, error: errorText(cause) }); },
    );
    return () => { current = false; };
  }, [folder, dashboardKey, readSkill]);
  const shown = read?.folder === folder ? read : null;
  const others = shown?.skill?.files.filter((file) => file.path !== "SKILL.md") ?? [];

  return (
    <Dialog open={skill !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl" aria-label={skill ? `The ${skill.name} skill` : undefined}>
        {skill && (<>
          <DialogHeader className="pr-8">
            <DialogTitle className="font-mono">{skill.name}</DialogTitle>
            <DialogDescription className="text-pretty">{skill.description}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto" data-skill-read={skill.name}>
            {skill.problem && <Alert><TriangleAlertIcon /><AlertTitle>Not loaded</AlertTitle><AlertDescription>{skill.problem}</AlertDescription></Alert>}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">From</dt>
              <dd className="min-w-0 [overflow-wrap:anywhere]">
                {!skill.source ? "Written by Perry in a chat, or put in his skills folder by hand."
                  : /^https?:\/\//i.test(skill.source) ? <>Imported from <a href={skill.source} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">{skill.source}</a></>
                  : <>Imported from <span className="font-mono text-[13px]">{skill.source}</span></>}
              </dd>
              <dt className="text-muted-foreground">Added</dt>
              <dd>{addedOn(skill.addedAt)}</dd>
              {shown?.skill && (<>
                <dt className="text-muted-foreground">File</dt>
                <dd className="flex min-w-0 items-center gap-1"><span className="min-w-0 truncate font-mono text-[12.5px]" title={shown.skill.path}>{shown.skill.path}</span><CopyButton value={shown.skill.path} label="Copy the path" size="icon-xs" /></dd>
              </>)}
            </dl>
            {shown?.error ? <p className="text-sm text-destructive" role="alert">{shown.error}</p>
              : !shown?.skill ? <div className="space-y-2" role="status" aria-label="Loading"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-5/6" /></div>
              : (
                <div className="rounded-xl border px-4 py-3" data-skill-md>
                  <p className="mb-2 font-mono text-xs text-muted-foreground">SKILL.md</p>
                  <Markdown text={readable(shown.skill.skill)} />
                </div>
              )}
            {others.length > 0 && (
              <div className="text-sm">
                <p className="mb-1 text-muted-foreground">Also in its folder</p>
                <ul className="space-y-0.5 font-mono text-[12.5px]">{others.map((file) => <li key={file.path}>{file.path} <span className="text-muted-foreground">({size(file.bytes)})</span></li>)}</ul>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <RemoveButton skill={skill} onRemove={() => onRemove(skill)} />
            {!skill.problem && <Button render={<Link href={`/chat?draft=${encodeURIComponent(`$${skill.name} `)}`} />}><MessageSquarePlusIcon />Use in a chat</Button>}
          </DialogFooter>
        </>)}
      </DialogContent>
    </Dialog>
  );
}
