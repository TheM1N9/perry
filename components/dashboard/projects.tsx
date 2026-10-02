"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  CheckIcon, FolderIcon, FolderInputIcon, FolderOpenIcon, FolderOutputIcon, FolderPlusIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, Trash2Icon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ChatSummary } from "@/convex/dashboard";
import type { ProjectSummary } from "@/convex/projects";
import { errorText } from "@/lib/format";
import { useSession } from "@/lib/session";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  SidebarGroup, SidebarGroupAction, SidebarGroupLabel, SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub,
} from "@/components/ui/sidebar";

/**
 * Projects in the dashboard (convex/projects.ts): folders of chats in the
 * sidebar, moving a chat in or out, and making, renaming and deleting one.
 */

type ProjectId = Id<"projects">;
type ChatId = Id<"conversations">;

/**
 * The sidebar's folders, each with its chats (drawn by `row`, as in the chat
 * list) and a way to start a new one in it. A folder is open while one of its
 * chats or its page is.
 */
export function ProjectFolders({ chats, row, onNewProject }: {
  chats: ChatSummary[] | undefined;
  row: (chat: ChatSummary) => ReactNode;
  onNewProject: () => void;
}) {
  const { dashboardKey } = useSession();
  const projects = useQuery(api.projects.list, { key: dashboardKey });
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const [removing, setRemoving] = useState<ProjectSummary | null>(null);
  if (!projects) return null;
  return (
    <SidebarGroup className="py-1 group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>Projects</SidebarGroupLabel>
      <Tooltip>
        <TooltipTrigger render={<SidebarGroupAction aria-label="New project" onClick={onNewProject} />}><PlusIcon /></TooltipTrigger>
        <TooltipContent side="right">New project</TooltipContent>
      </Tooltip>
      <SidebarMenu aria-label="Projects">
        {projects.map((project) => (
          <Folder key={project.id} project={project} chats={(chats ?? []).filter((chat) => chat.projectId === project.id)} row={row}
            onRename={() => setRenaming(project)} onDelete={() => setRemoving(project)} />
        ))}
        {projects.length === 0 && (
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onNewProject} className="text-sidebar-foreground/70"><FolderPlusIcon />New project</SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
      <RenameProjectDialog project={renaming} onClose={() => setRenaming(null)} />
      <DeleteProjectDialog project={removing} onClose={() => setRemoving(null)} />
    </SidebarGroup>
  );
}

function Folder({ project, chats, row, onRename, onDelete }: {
  project: ProjectSummary; chats: ChatSummary[]; row: (chat: ChatSummary) => ReactNode; onRename: () => void; onDelete: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const here = pathname === `/projects/${project.id}` || chats.some((chat) => pathname === `/chat/${chat.id}`);
  const [open, setOpen] = useState(here);
  useEffect(() => { if (here) setOpen(true); }, [here]);
  return (
    <Collapsible open={open} onOpenChange={setOpen} render={<SidebarMenuItem />}>
      <CollapsibleTrigger render={<SidebarMenuButton isActive={pathname === `/projects/${project.id}`} aria-label={`${project.name}, a project`} />}>
        {open ? <FolderOpenIcon /> : <FolderIcon />}
        <span className="pr-4">{project.name}</span>
      </CollapsibleTrigger>
      <DropdownMenu>
        <DropdownMenuTrigger render={<SidebarMenuAction showOnHover aria-label={`Options for ${project.name}`} />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-48">
          <DropdownMenuItem onClick={() => router.push(`/projects/${project.id}`)}><FolderOpenIcon />Open project</DropdownMenuItem>
          <DropdownMenuItem onClick={() => router.push(`/chat?project=${project.id}`)}><PlusIcon />New chat in it</DropdownMenuItem>
          <DropdownMenuItem onClick={onRename}><PencilIcon />Rename</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}><Trash2Icon />Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CollapsibleContent>
        <SidebarMenuSub aria-label={`Chats in ${project.name}`} className="mr-0 gap-0.5 pr-0">
          {chats.map(row)}
          <SidebarMenuItem>
            <SidebarMenuButton size="sm" render={<Link href={`/chat?project=${project.id}`} />} className="text-sidebar-foreground/70">
              <PlusIcon />New chat
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenuSub>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * "Move to project" in a chat's menu: into any project, out of the one it is
 * in, or into a new one. Only for the owner's own web chats.
 */
export function MoveToProject({ chat, onNewProject }: { chat: { id: ChatId; projectId?: ProjectId }; onNewProject: () => void }) {
  const { dashboardKey } = useSession();
  const projects = useQuery(api.projects.list, { key: dashboardKey });
  const move = useMoveChat();
  const current = projects?.find((project) => project.id === chat.projectId);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger><FolderInputIcon />{current ? "Move to another project" : "Move to project"}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-52">
        {projects?.filter((project) => project.id !== chat.projectId).map((project) => (
          <DropdownMenuItem key={project.id} onClick={() => move(chat.id, project)}><FolderIcon />{project.name}</DropdownMenuItem>
        ))}
        {current && <DropdownMenuItem disabled><CheckIcon />{current.name}</DropdownMenuItem>}
        {Boolean(projects?.length) && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={onNewProject}><FolderPlusIcon />New project…</DropdownMenuItem>
        {current && <DropdownMenuItem onClick={() => move(chat.id, null)}><FolderOutputIcon />Take out of {current.name}</DropdownMenuItem>}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** Move a chat into a project, or with null out of its own, and say so. */
export function useMoveChat() {
  const { dashboardKey } = useSession();
  const moveChat = useMutation(api.projects.moveChat).withOptimisticUpdate((store, args) => {
    const list = store.getQuery(api.dashboard.listChats, { key: args.key });
    if (list) store.setQuery(api.dashboard.listChats, { key: args.key }, list.map((item) => item.id === args.id ? { ...item, projectId: args.projectId ?? undefined } : item));
  });
  return (id: ChatId, project: { id: ProjectId; name: string } | null) => moveChat({ key: dashboardKey, id, projectId: project?.id ?? null })
    .then(() => toast.success(project
      ? `Moved into ${project.name}.`
      : "Taken out of the project. Its memories stay with the project."))
    .catch((cause) => toast.error(`Couldn't move it: ${errorText(cause)}`));
}

/** Make a project; with `chat`, that chat moves into it. Without, the new project's page opens. */
export function NewProjectDialog({ open, chat, onClose }: { open: boolean; chat?: ChatId; onClose: () => void }) {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const create = useMutation(api.projects.create);
  const move = useMoveChat();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) setName(""); }, [open]);

  const save = async () => {
    const clean = name.trim();
    if (!clean || saving) return;
    setSaving(true);
    try {
      const id = await create({ key: dashboardKey, name: clean });
      onClose();
      if (chat) await move(chat, { id, name: clean });
      else router.push(`/projects/${id}`);
    } catch (cause) {
      toast.error(`Couldn't make it: ${errorText(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Chats in it share instructions and memory.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="contents">
          <Input aria-label="Project name" placeholder="Hackonomics scripts" value={name} maxLength={80} autoFocus required onChange={(event) => setName(event.target.value)} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving} aria-busy={saving || undefined}>{saving && <Spinner />}Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RenameProjectDialog({ project, onClose }: { project: { id: ProjectId; name: string } | null; onClose: () => void }) {
  const { dashboardKey } = useSession();
  const rename = useMutation(api.projects.rename);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (project) setName(project.name); }, [project]);

  const save = async () => {
    if (!project || !name.trim()) return;
    setSaving(true);
    try {
      await rename({ key: dashboardKey, id: project.id, name });
      onClose();
    } catch (cause) {
      toast.error(`Couldn't rename it: ${errorText(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={project !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Rename project</DialogTitle></DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="contents">
          <Input aria-label="Project name" value={name} maxLength={80} autoFocus required onChange={(event) => setName(event.target.value)} onFocus={(event) => event.currentTarget.select()} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving} aria-busy={saving || undefined}>{saving && <Spinner />}Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Deleting a project keeps its chats, back in the chat list, and deletes what Perry remembered for it. */
export function DeleteProjectDialog({ project, onClose }: { project: { id: ProjectId; name: string } | null; onClose: () => void }) {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const view = useQuery(api.projects.get, project ? { key: dashboardKey, id: project.id } : "skip");
  const remove = useMutation(api.projects.remove);
  const [deleting, setDeleting] = useState(false);
  const chats = view?.chats.length ?? 0;
  const memories = view?.memories.length ?? 0;
  const notes = view?.notes ?? 0;

  const confirm = async () => {
    if (!project) return;
    setDeleting(true);
    try {
      await remove({ key: dashboardKey, id: project.id });
      if (pathname === `/projects/${project.id}`) router.replace("/chat");
      toast.success("Project deleted. Its chats are back in your chat list.");
      onClose();
    } catch (cause) {
      toast.error(`Couldn't delete it: ${errorText(cause)}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog open={project !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this project?</AlertDialogTitle>
          <AlertDialogDescription>
            {chats ? `Its ${chats === 1 ? "chat stays" : `${chats} chats stay`}, back in your chat list, without the project's instructions. ` : ""}
            {memories
              ? `What Perry remembered for “${project?.name}” (${memories === 1 ? "one memory" : `${memories} memories`}) is deleted with it, so none of it reaches your other chats.`
              : `“${project?.name}” and its instructions go for good.`}
            {notes ? ` Its ${notes === 1 ? "note stays" : `${notes} notes stay`} in Notes, where all your chats can reach ${notes === 1 ? "it" : "them"}.` : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={deleting || view === undefined} onClick={() => void confirm()}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
