"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { FolderOutputIcon, MessageSquareIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import { noteHref } from "@/convex/lib/notes";
import type { ProjectView } from "@/convex/projects";
import { errorText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { SaveStatus, useAutosave } from "../autosave";
import { ActionButton, EmptyState, List, ListSkeleton, Page, RelativeTime, Section, StatusBadge } from "../common";
import { DeleteProjectDialog, RenameProjectDialog, useMoveChat } from "../projects";
import { NoteRows } from "./notes";

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
        <EmptyState mascot title="This project isn't here" action={<Button variant="outline" size="sm" render={<Link href="/chat" />}>New chat</Button>}>
          It may have been deleted.
        </EmptyState>
      </Page>
    );
  }
  return (
    <Page
      title={project.name}
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
      <Section title="Instructions" tip="Every chat in the project follows them, from your next message.">
        <Instructions project={project} />
      </Section>
      <Section title="Notes" tip="Its chats are told each note's title, and Perry reads one when it matters. Chats outside the project can't reach them." actions={<NewNote project={project} />}>
        <Notes project={project} />
      </Section>
      <Section title="Chats" tip="They know of each other and can read each other. Chats outside the project can't.">
        <Chats project={project} />
      </Section>
      <Section title="Memory" description="Only this project's chats see it.">
        <Memories project={project} />
      </Section>
      <RenameProjectDialog project={renaming ? project : null} onClose={() => setRenaming(false)} />
      <DeleteProjectDialog project={removing ? project : null} onClose={() => setRemoving(false)} />
    </Page>
  );
}

/** The project's instructions, saved as you type: a pause, or leaving the field, saves them. */
function Instructions({ project }: { project: ProjectView }) {
  const { dashboardKey } = useSession();
  const save = useMutation(api.projects.setInstructions);
  const instructions = useAutosave({ saved: project.instructions, save: (text) => save({ key: dashboardKey, id: project.id, instructions: text }) });
  return (
    <Field>
      <FieldLabel htmlFor="project-instructions" className="sr-only">Instructions for {project.name}</FieldLabel>
      <Textarea id="project-instructions" value={instructions.value} rows={6} maxLength={8000} className="min-h-36 leading-relaxed" {...instructions.field}
        placeholder={"For example:\nScripts for the Hackonomics YouTube channel: money explained for people in their twenties.\nHook in the first line, short sentences, no jargon, 8 to 10 minutes read aloud.\nEnd every script with one question for the comments."}
        onChange={(event) => instructions.change(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void instructions.flush(); } }} />
      <SaveStatus state={instructions.state} idle="Saves as you type." onRetry={() => void instructions.flush()} />
    </Field>
  );
}

function NewNote({ project }: { project: ProjectView }) {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const create = useMutation(api.notes.create);
  return (
    <Button variant="outline" size="sm" onClick={() => void create({ key: dashboardKey, projectId: project.id }).then((id) => router.push(noteHref(id)), (cause) => toast.error(`Couldn't make it: ${errorText(cause)}`))}>
      <PlusIcon />New note
    </Button>
  );
}

function Notes({ project }: { project: ProjectView }) {
  const { dashboardKey } = useSession();
  const notes = useQuery(api.notes.list, { key: dashboardKey, projectId: project.id });
  if (notes === undefined) return <ListSkeleton rows={2} />;
  if (!notes.length) return <EmptyState title="No notes yet">A plan or a list every chat here should be able to read.</EmptyState>;
  return <NoteRows notes={notes} hideProject />;
}

function Chats({ project }: { project: ProjectView }) {
  const move = useMoveChat();
  if (!project.chats.length) {
    return (
      <EmptyState title="No chats yet" action={<Button variant="outline" size="sm" render={<Link href={`/chat?project=${project.id}`} />}><PlusIcon />Start one</Button>} />
    );
  }
  return (
    <List label={`${project.name}'s chats`}>
      {project.chats.map((chat) => (
        <li key={chat.id} className="flex items-center gap-3 px-4 py-3">
          <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Link href={`/chat/${chat.id}`} className="min-w-0 flex-1 truncate text-md hover:underline underline-offset-2">{chat.title}</Link>
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
    return <EmptyState title="Nothing remembered here yet" />;
  }
  return (
    <List label={`What Perry remembers in ${project.name}`}>
      {project.memories.map((memory) => (
        <li key={memory.id} className="flex items-start gap-4 px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <p className="text-md text-pretty [overflow-wrap:anywhere]">{memory.text}</p>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
              <span>{KINDS[memory.kind]}</span>
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
