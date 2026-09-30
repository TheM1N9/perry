"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  ActivityIcon, BookUserIcon, CableIcon, CheckCircle2Icon, ChevronsUpDownIcon, InboxIcon, ListChecksIcon, LockIcon, MonitorIcon,
  MoreHorizontalIcon, PencilIcon, PinIcon, PinOffIcon, PowerIcon, PowerOffIcon, PuzzleIcon, SearchIcon, SettingsIcon, SquarePenIcon, SunMoonIcon, Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { ChatSummary } from "@/convex/dashboard";
import { ACTIVE_CHAT, useSession } from "@/lib/session";
import { dayGroup, errorText } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useShortcuts } from "@/hooks/use-shortcuts";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent,
  DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader,
  SidebarMenu, SidebarMenuAction, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton, SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { usePalette } from "./command-palette";
import { ChannelIcon, PerryMark } from "./common";
import { StatusIndicator } from "./status-indicator";
import { useNeedsYouCount } from "./needs-you-count";
import { UpdateNotice } from "./updates";
import { PlatypusArt } from "./platypus";
import { MoveToProject, NewProjectDialog, ProjectFolders } from "./projects";
import { Spinner } from "@/components/ui/spinner";

/** How many chats show before "Show all", so a long history stays scannable. */
const CHAT_PAGE = 25;

export function AppSidebar() {
  const { dashboardKey } = useSession();
  const pathname = usePathname();
  const palette = usePalette();
  const { setOpenMobile } = useSidebar();
  const count = useNeedsYouCount();
  const { label } = useShortcuts();
  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  const assistant = status?.assistantName ?? "Perry";

  // On a phone the sidebar is a sheet; going somewhere closes it.
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]);

  return (
    <Sidebar collapsible="icon" variant="sidebar">
      <SidebarHeader className="pb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/chat" />} tooltip={assistant} className="gap-2.5">
              <PerryMark className="size-8" />
              <span className="truncate text-[15px] font-semibold tracking-[-0.01em]" translate="no">{assistant}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link href="/chat" />} isActive={pathname === "/chat"} tooltip="New chat">
                  <SquarePenIcon />
                  <span>New chat</span>
                </SidebarMenuButton>
                <SidebarMenuBadge className="opacity-0 transition-opacity max-md:hidden group-hover/menu-item:opacity-100">
                  <Kbd className="h-5">{label("newChat")}</Kbd>
                </SidebarMenuBadge>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={palette.open} tooltip="Search" aria-keyshortcuts="Control+K Meta+K">
                  <SearchIcon />
                  <span>Search</span>
                </SidebarMenuButton>
                <SidebarMenuBadge className="max-md:hidden"><Kbd className="h-5">{label("palette")}</Kbd></SidebarMenuBadge>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link href="/inbox" />} isActive={pathname === "/inbox"} tooltip="Needs you">
                  <InboxIcon />
                  <span>Needs you</span>
                </SidebarMenuButton>
                {count > 0 && (
                  <SidebarMenuBadge className="rounded-full bg-warning px-1.5 text-[11px] font-semibold text-background peer-data-active/menu-button:text-background">
                    {count}
                  </SidebarMenuBadge>
                )}
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link href="/todos" />} isActive={pathname === "/todos"} tooltip="To-dos">
                  <CheckCircle2Icon />
                  <span>To-dos</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton render={<Link href="/work" />} isActive={pathname.startsWith("/work")} tooltip="Work">
                  <ListChecksIcon />
                  <span>Work</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <ChatGroups />
      </SidebarContent>
      <SidebarFooter>
        <UpdateNotice />
        <DesktopPet />
        <ComputerStatus />
        <AccountMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function ChatGroups() {
  const { dashboardKey } = useSession();
  const all = useQuery(api.dashboard.listChats, { key: dashboardKey });
  const [showAll, setShowAll] = useState(false);
  const [renaming, setRenaming] = useState<ChatSummary | null>(null);
  const [removing, setRemoving] = useState<ChatSummary | null>(null);
  /** A project being made, and the chat that moves into it, if any. */
  const [creating, setCreating] = useState<{ chat?: ChatSummary["id"] } | null>(null);
  const row = (chat: ChatSummary) => (
    <ChatRow key={chat.id} chat={chat} onRename={() => setRenaming(chat)} onDelete={() => setRemoving(chat)} onNewProject={() => setCreating({ chat: chat.id })} />
  );
  // A project's chats are in its folder, not in the list.
  const chats = useMemo(() => all?.filter((chat) => !chat.projectId), [all]);

  const groups = useMemo(() => {
    if (!chats) return [];
    const pinned = chats.filter((chat) => chat.pinned);
    const rest = chats.filter((chat) => !chat.pinned);
    const shown = showAll ? rest : rest.slice(0, CHAT_PAGE);
    const byDay = new Map<string, ChatSummary[]>();
    const now = Date.now();
    for (const chat of shown) {
      const label = dayGroup(chat.lastMessageAt, now);
      byDay.set(label, [...(byDay.get(label) ?? []), chat]);
    }
    return [
      ...(pinned.length ? [{ label: "Pinned", chats: pinned }] : []),
      ...[...byDay].map(([label, items]) => ({ label, chats: items })),
    ];
  }, [chats, showAll]);
  const hidden = chats ? chats.filter((chat) => !chat.pinned).length - CHAT_PAGE : 0;

  if (chats === undefined) {
    return (
      <SidebarGroup className="group-data-[collapsible=icon]:hidden">
        <SidebarGroupLabel>Chats</SidebarGroupLabel>
        <SidebarMenu>{Array.from({ length: 6 }, (_, index) => <SidebarMenuItem key={index}><SidebarMenuSkeleton /></SidebarMenuItem>)}</SidebarMenu>
      </SidebarGroup>
    );
  }
  return (
    <>
      <ProjectFolders chats={all} row={row} onNewProject={() => setCreating({})} />
      {!chats.length && (
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <p className="px-2 py-1 text-sm text-muted-foreground">Your chats will show up here.</p>
        </SidebarGroup>
      )}
      {groups.map((group) => (
        <SidebarGroup key={group.label} className="py-1 group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
          <SidebarMenu aria-label={group.label}>
            {group.chats.map(row)}
          </SidebarMenu>
        </SidebarGroup>
      ))}
      {hidden > 0 && !showAll && (
        <div className="px-4 pb-3 group-data-[collapsible=icon]:hidden">
          <Button variant="link" size="sm" className="h-auto px-0 text-sidebar-foreground/70" onClick={() => setShowAll(true)}>
            Show {hidden} older {hidden === 1 ? "chat" : "chats"}
          </Button>
        </div>
      )}
      <RenameDialog chat={renaming} onClose={() => setRenaming(null)} />
      <DeleteDialog chat={removing} onClose={() => setRemoving(null)} />
      <NewProjectDialog open={creating !== null} chat={creating?.chat} onClose={() => setCreating(null)} />
    </>
  );
}

function ChatRow({ chat, onRename, onDelete, onNewProject }: { chat: ChatSummary; onRename: () => void; onDelete: () => void; onNewProject: () => void }) {
  const { dashboardKey } = useSession();
  const pathname = usePathname();
  const active = pathname === `/chat/${chat.id}`;
  const setPinned = useMutation(api.dashboard.setChatPinned).withOptimisticUpdate((store, args) => {
    const list = store.getQuery(api.dashboard.listChats, { key: args.key });
    if (list) store.setQuery(api.dashboard.listChats, { key: args.key }, list.map((item) => item.id === args.id ? { ...item, pinned: args.pinned } : item));
  });
  const pin = () => void setPinned({ key: dashboardKey, id: chat.id, pinned: !chat.pinned })
    .catch((cause) => toast.error(`Couldn't ${chat.pinned ? "unpin" : "pin"} it: ${errorText(cause)}`));

  return (
    <SidebarMenuItem>
      <SidebarMenuButton render={<Link href={`/chat/${chat.id}`} />} isActive={active}
        className={cn(chat.unseen && !active && "font-semibold")}
        aria-current={active ? "page" : undefined}>
        <ChannelIcon channel={chat.channel} />
        <span className={cn("pr-4", chat.naming && "shimmer")} aria-busy={chat.naming || undefined}>{chat.title}</span>
      </SidebarMenuButton>
      <StatusIndicator status={chat.status} unseen={chat.unseen && !active}
        className="pointer-events-none absolute top-1/2 right-8 -translate-y-1/2 transition-opacity md:right-1.5 md:group-focus-within/menu-item:opacity-0 md:group-hover/menu-item:opacity-0" />
      <DropdownMenu>
        <DropdownMenuTrigger render={<SidebarMenuAction showOnHover aria-label={`Options for ${chat.title}`} />}>
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-44">
          <DropdownMenuItem onClick={pin}>{chat.pinned ? <PinOffIcon /> : <PinIcon />}{chat.pinned ? "Unpin" : "Pin"}</DropdownMenuItem>
          <DropdownMenuItem onClick={onRename}><PencilIcon />Rename</DropdownMenuItem>
          {/* A Telegram or WhatsApp chat goes on as long as the app is paired; its messages are already on the phone. */}
          {chat.channel === "web" && <>
            <MoveToProject chat={chat} onNewProject={onNewProject} />
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}><Trash2Icon />Delete</DropdownMenuItem>
          </>}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

export function RenameDialog({ chat, onClose }: { chat: { id: ChatSummary["id"]; title: string } | null; onClose: () => void }) {
  const { dashboardKey } = useSession();
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const renameChat = useMutation(api.dashboard.renameChat).withOptimisticUpdate((store, args) => {
    const list = store.getQuery(api.dashboard.listChats, { key: args.key });
    if (list) store.setQuery(api.dashboard.listChats, { key: args.key }, list.map((item) => item.id === args.id ? { ...item, title: args.title.trim(), naming: false } : item));
  });
  useEffect(() => { if (chat) setTitle(chat.title); }, [chat]);

  const save = async () => {
    if (!chat || !title.trim()) return;
    setSaving(true);
    try {
      await renameChat({ key: dashboardKey, id: chat.id, title });
      onClose();
    } catch (cause) {
      toast.error(`Couldn't rename it: ${errorText(cause)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={chat !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Rename chat</DialogTitle></DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="contents">
          <Input aria-label="Chat name" value={title} maxLength={100} autoFocus onChange={(event) => setTitle(event.target.value)} onFocus={(event) => event.currentTarget.select()} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!title.trim() || saving}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteDialog({ chat, onClose }: { chat: { id: ChatSummary["id"]; title: string } | null; onClose: () => void }) {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const deleteChat = useMutation(api.dashboard.deleteChat);
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    if (!chat) return;
    setDeleting(true);
    try {
      await deleteChat({ key: dashboardKey, id: chat.id });
      if (window.localStorage.getItem(ACTIVE_CHAT) === chat.id) window.localStorage.removeItem(ACTIVE_CHAT);
      if (pathname === `/chat/${chat.id}`) router.replace("/chat");
      toast.success("Chat deleted.");
      onClose();
    } catch (cause) {
      toast.error(`Couldn't delete it: ${errorText(cause)}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog open={chat !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
          <AlertDialogDescription>
            &ldquo;{chat?.title}&rdquo; and its messages go for good. What Perry saved to memory from it stays.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={deleting} onClick={() => void remove()}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The desktop pet, from anywhere in the dashboard: on or off on the computer
 * Perry runs on, turned either way from his menu, which also leads to his
 * settings. While he is being set up, the step it is on.
 */
function DesktopPet() {
  const { dashboardKey } = useSession();
  const router = useRouter();
  const { isMobile } = useSidebar();
  const pet = useQuery(api.pet.status, { key: dashboardKey });
  const turnOn = useAction(api.pet.turnOn);
  const turnOff = useAction(api.pet.turnOff);
  // It runs as long as setup takes, minutes the first time; the item follows it in pet.status, not in this call.
  const start = (which: typeof turnOn) => void which({ key: dashboardKey }).catch((cause) => toast.error(errorText(cause)));
  const working = pet?.setup?.state === "working";
  const failed = !working && pet?.setup?.state === "failed";
  const state = pet === undefined ? "Checking…" : working ? (pet.setup?.step ?? (pet.setup?.action === "off" ? "Turning him off…" : "Getting him ready…"))
    : pet.running ? "On your desktop" : failed ? "Couldn't start him" : "Not on your desktop";
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton className="data-popup-open:bg-sidebar-accent" tooltip={`Desktop pet · ${state}`} />}>
            <PlatypusArt head asleep={!pet?.running && !working} hat={Boolean(pet?.running) || working} className="size-4 shrink-0" />
            <span className="truncate">Desktop pet</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent side={isMobile ? "top" : "right"} align="end" sideOffset={8} className="w-64">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal">
                <span className="block text-sm font-medium text-foreground">{state}</span>
                {pet && <span className="block text-xs text-pretty text-muted-foreground">
                  {failed ? pet.setup?.error?.split("\n")[0] : pet.running ? `On ${pet.host}, and he starts with it.` : `He'd appear on ${pet.host}, the computer Perry runs on.`}
                </span>}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            {pet?.running
              ? <DropdownMenuItem disabled={working} onClick={() => start(turnOff)}><PowerOffIcon />Turn him off</DropdownMenuItem>
              : <DropdownMenuItem disabled={working || pet === undefined} onClick={() => start(turnOn)}><PowerIcon />{failed ? "Try again" : "Turn him on"}</DropdownMenuItem>}
            <DropdownMenuItem onClick={() => router.push("/settings?tab=general")}><SettingsIcon />Pet settings</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {pet !== undefined && (
          <SidebarMenuBadge>
            {working ? <Spinner className="size-3" />
              : <span className={cn("size-2 rounded-full", pet.running ? "bg-success" : failed ? "bg-destructive" : "bg-muted-foreground/40")} aria-label={pet.running ? "On" : failed ? "Failed" : "Off"} role="img" />}
          </SidebarMenuBadge>
        )}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** Whether a computer is online to do the work: Perry can only act through one. */
function ComputerStatus() {
  const { dashboardKey } = useSession();
  const pathname = usePathname();
  const compute = useQuery(api.dashboard.getCompute, { key: dashboardKey });
  const live = compute?.runners.filter((runner) => !runner.revoked) ?? [];
  const online = live.filter((runner) => runner.online);
  const label = compute === undefined ? "Checking…" : online.length ? (online.length === 1 ? online[0].name : `${online.length} computers`) : live.length ? "Computer offline" : "No computer yet";
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton render={<Link href="/computer" />} isActive={pathname === "/computer"} tooltip={`${label}${online.length ? " · online" : ""}`}>
          <MonitorIcon />
          <span className="truncate">{label}</span>
        </SidebarMenuButton>
        {compute !== undefined && (
          <SidebarMenuBadge>
            <span className={cn("size-2 rounded-full", online.length ? "bg-success" : "bg-muted-foreground/40")} aria-label={online.length ? "Online" : "Offline"} role="img" />
          </SidebarMenuBadge>
        )}
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function AccountMenu() {
  const { dashboardKey, lock } = useSession();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { isMobile } = useSidebar();
  const status = useQuery(api.dashboard.getStatus, { key: dashboardKey });
  const name = status?.displayName ?? "You";
  const pairing = Boolean(status?.telegramConfigured && !status.claimed);
  const go = (href: string) => router.push(href);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" className="data-popup-open:bg-sidebar-accent" />}>
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-[13px] font-semibold text-background" aria-hidden>
              {name.charAt(0).toUpperCase()}
            </span>
            <span className="grid min-w-0 flex-1 text-left leading-tight">
              <span className="truncate text-sm font-medium">{name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {status === undefined ? " " : pairing ? "Telegram not paired" : `${status.memories} ${status.memories === 1 ? "memory" : "memories"}`}
              </span>
            </span>
            <ChevronsUpDownIcon className="ml-auto text-sidebar-foreground/50" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side={isMobile ? "top" : "right"} align="end" sideOffset={8} className="w-60">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{name}</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => go("/memory")}><BookUserIcon />Memory</DropdownMenuItem>
              <DropdownMenuItem onClick={() => go("/skills")}><PuzzleIcon />Skills</DropdownMenuItem>
              <DropdownMenuItem onClick={() => go("/connectors")}><CableIcon />Connectors</DropdownMenuItem>
              <DropdownMenuItem onClick={() => go("/activity")}><ActivityIcon />Activity</DropdownMenuItem>
              <DropdownMenuItem onClick={() => go("/computer")}><MonitorIcon />Computer</DropdownMenuItem>
              <DropdownMenuItem onClick={() => go("/settings")}><SettingsIcon />Settings</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger><SunMoonIcon />Theme</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={(value) => setTheme(value as string)}>
                  <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={lock}><LockIcon />Lock dashboard</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
