"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { FolderOutputIcon, MessageSquareIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { ProjectView } from "@/convex/projects";
import { errorText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ActionButton, EmptyState, List, ListSkeleton, Page, RelativeTime, Section, StatusBadge } from "../common";
import { DeleteProjectDialog, RenameProjectDialog, useMoveChat } from "../projects";

const KINDS = { profile: "Profile", core: "Long-term", daily: "Daily note" } as const;

/**
 * A project's page (convex/projects.ts): the instructions its chats follow,
 * its chats, and what Perry remembers in them.
 */
export function ProjectScreen() {
  const { dashboardKey } = useSession();
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id);
  const project = useQuery(api.projects.get, { key: dashboardKey, id });
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  useEffect(() => { if (project) document.title = `${project.name} · Perry`; }, [project?.name]);

  if (project === undefined) return <Page title="Project"><ListSkeleton rows={3} /></Page>;
  if (project === null) {
    return (
      <Page title="Project">
        <EmptyState title="This project isn't here" action={<Button variant="outline" size="sm" render={<Link href="/chat" />}>New chat</Button>}>
          It may have been deleted. Its chats, if it had any, are in your chat list.
        </EmptyState>
      </Page>
    );
  }
  return (
    <Page
      title={project.name}
      description="A folder of chats about one thing. Its chats follow its instructions, know of each other and can read each other, and keep what Perry remembers in them to the project."
      actions={<>
        <Button render={<Link href={`/chat?project=${project.id}`} />}><PlusIcon />New chat</Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label="Project options" />}><MoreHorizontalIcon /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => setRenaming(true)}><PencilIcon />Rename</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setRemoving(true)}><Trash2Icon />Delete</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>}
    >
      <Section title="Instructions" description="How Perry works in this project: tone, format, audience, standing rules. A change reaches every chat in it with your next message, chats already going too.">
        <Instructions project={project} />
      </Section>
      <Section title="Chats" description="Each one is told what the others are about, and can search and read them. Chats outside the project cannot.">
        <Chats project={project} />
      </Section>
      <Section title="Memory" description="What Perry remembers in this project's chats. Only they see it; what Perry saves for every chat is on the Memory page.">
        <Memories project={project} />
      </Section>
      <RenameProjectDialog project={renaming ? project : null} onClose={() => setRenaming(false)} />
      <DeleteProjectDialog project={removing ? project : null} onClose={() => setRemoving(false)} />
    </Page>
  );
}

function Instructions({ project }: { project: ProjectView }) {
  const { dashboardKey } = useSession();
  const save = useMutation(api.projects.setInstructions);
  // The draft follows the saved text until it is edited, so a change made elsewhere shows up.
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const text = draft ?? project.instructions;
  const dirty = text.trim() !== project.instructions;
  useEffect(() => { if (draft !== null && draft.trim() === project.instructions) setDraft(null); }, [draft, project.instructions]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const { changed } = await save({ key: dashboardKey, id: project.id, instructions: text });
      setDraft(null);
      toast.success(changed ? "Saved. Every chat in the project follows them from its next message." : "Nothing changed.");
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="rounded-xl border bg-card p-4" onSubmit={(event) => void submit(event)}>
      <Field>
        <FieldLabel htmlFor="project-instructions" className="sr-only">Instructions for {project.name}</FieldLabel>
        <Textarea id="project-instructions" value={text} rows={6} maxLength={8000} className="min-h-36 leading-relaxed"
          placeholder={"For example:\nScripts for the Hackonomics YouTube channel: money explained for people in their twenties.\nHook in the first line, short sentences, no jargon, 8 to 10 minutes read aloud.\nEnd every script with one question for the comments."}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <FieldDescription>Ctrl+Enter saves.</FieldDescription>
      </Field>
      <div className="mt-3 flex gap-2">
        <Button type="submit" disabled={!dirty || saving}>{saving && <Spinner />}Save</Button>
        {dirty && <Button type="button" variant="ghost" onClick={() => setDraft(null)} disabled={saving}>Discard</Button>}
      </div>
    </form>
  );
}

function Chats({ project }: { project: ProjectView }) {
  const move = useMoveChat();
  if (!project.chats.length) {
    return (
      <EmptyState title="No chats yet" action={<Button variant="outline" size="sm" render={<Link href={`/chat?project=${project.id}`} />}><PlusIcon />Start one</Button>}>
        Start a chat here, or move one in from its menu.
      </EmptyState>
    );
  }
  return (
    <List label={`${project.name}'s chats`}>
      {project.chats.map((chat) => (
        <li key={chat.id} className="flex items-center gap-3 px-4 py-3">
          <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Link href={`/chat/${chat.id}`} className="min-w-0 flex-1 truncate text-[15px] hover:underline underline-offset-2">{chat.title}</Link>
          {(chat.job || chat.task) && <StatusBadge>{chat.job ? "Schedule" : "Task"}</StatusBadge>}
          <RelativeTime at={chat.lastMessageAt} className="shrink-0 text-xs text-muted-foreground" />
          <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground" onClick={() => void move(chat.id, null)}>
            <FolderOutputIcon />Take out
          </Button>
        </li>
      ))}
    </List>
  );
}

function Memories({ project }: { project: ProjectView }) {
  const { dashboardKey } = useSession();
  const forget = useMutation(api.dashboard.deleteMemory);
  if (!project.memories.length) {
    return <EmptyState title="Nothing remembered here yet">What Perry saves in this project&apos;s chats shows up here.</EmptyState>;
  }
  return (
    <List label={`What Perry remembers in ${project.name}`}>
      {project.memories.map((memory) => (
        <li key={memory.id} className="flex items-start gap-4 px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <p className="text-[15px] text-pretty [overflow-wrap:anywhere]">{memory.text}</p>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
              <StatusBadge>{KINDS[memory.kind]}</StatusBadge>
              <RelativeTime at={memory.editedAt ?? memory.createdAt} />
            </p>
          </div>
          <ActionButton variant="ghost" size="sm" className="shrink-0 text-muted-foreground hover:text-destructive" action={() => forget({ key: dashboardKey, id: memory.id })} success="Forgotten."
            confirm={{ title: "Forget this?", body: <>&ldquo;{memory.text.length > 160 ? `${memory.text.slice(0, 160)}…` : memory.text}&rdquo; is deleted, and Perry won&apos;t recall it again.</>, label: "Forget" }}>
            Forget
          </ActionButton>
        </li>
      ))}
    </List>
  );
}
