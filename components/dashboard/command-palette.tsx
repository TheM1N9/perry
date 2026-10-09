"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  ActivityIcon, BookUserIcon, BrainIcon, LibraryIcon, CableIcon, CheckCircle2Icon, CpuIcon, FilePlusIcon, FileTextIcon, GaugeIcon, InboxIcon, KeyboardIcon, KeyRoundIcon, ListChecksIcon, LockIcon,
  MessageSquareIcon, MonitorIcon, MoonIcon, PuzzleIcon, SettingsIcon, ShieldCheckIcon, SquarePenIcon, SunIcon, TextSearchIcon,
} from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { noteHref } from "@/convex/lib/notes";
import type { Found as BrainHit } from "@/convex/pages";
import { useSession } from "@/lib/session";
import { useShortcuts } from "@/hooks/use-shortcuts";
import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut,
} from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";

export const PaletteContext = createContext<{ open: () => void }>({ open: () => {} });
export const usePalette = () => useContext(PaletteContext);

const PAGES = [
  { href: "/inbox", label: "Needs you", icon: InboxIcon },
  { href: "/todos", label: "To-dos", icon: CheckCircle2Icon },
  { href: "/brain", label: "Brain", icon: BrainIcon },
  { href: "/library", label: "Library", icon: LibraryIcon },
  { href: "/work", label: "Work", icon: ListChecksIcon },
  { href: "/apps/connectors", label: "Connectors", icon: CableIcon },
  { href: "/apps/skills", label: "Skills", icon: PuzzleIcon },
  { href: "/settings/general", label: "Settings", icon: SettingsIcon },
  { href: "/settings/engines", label: "Engines", icon: CpuIcon },
  { href: "/settings/usage", label: "Usage", icon: GaugeIcon },
  { href: "/settings/computers", label: "Computers", icon: MonitorIcon },
  { href: "/settings/access", label: "Access & approvals", icon: ShieldCheckIcon },
  { href: "/settings/logins", label: "Logins & secrets", icon: KeyRoundIcon },
  { href: "/settings/activity", label: "Activity log", icon: ActivityIcon },
  { href: "/settings/desktop-pet#shortcuts", label: "Keyboard shortcuts", icon: KeyboardIcon },
];

type Found = { id: Id<"conversations">; title: string; snippet: string };
type Recalled = { term: string; results: BrainHit[] };

/** Where a hit opens: its page, or for a memory not yet in one, Brain's search. */
const hrefOf = (hit: BrainHit) => hit.page ? noteHref(hit.page.id) : `/brain?q=${encodeURIComponent(hit.text)}`;
const MEMORY_KIND = { profile: "Profile", core: "Long-term", daily: "Daily note", page: "Note" } as const;

/**
 * Search (⌘K unless changed in Settings): every chat by title, what was said in them, notes by title, memory and notes by words and meaning, every page, and the few
 * things you do from anywhere. Titles filter as you type; message text is
 * searched on the server once you pause.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { dashboardKey, lock } = useSession();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const { label: shortcutLabel } = useShortcuts();
  const chats = useQuery(api.dashboard.listChats, open ? { key: dashboardKey } : "skip");
  const notes = useQuery(api.notes.list, open ? { key: dashboardKey } : "skip");
  const createNote = useMutation(api.notes.create);
  const searchChats = useAction(api.dashboard.searchChats);
  const searchBrain = useAction(api.pages.search);
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<{ term: string; results: Found[] } | null>(null);
  const [recalled, setRecalled] = useState<Recalled | null>(null);
  const term = search.trim();

  useEffect(() => { if (!open) { setSearch(""); setFound(null); setRecalled(null); } }, [open]);
  // Memory and notes, one search by words and by meaning (pages.search), once typing pauses.
  useEffect(() => {
    if (term.length < 2) { setRecalled(null); return; }
    let current = true;
    const timer = window.setTimeout(() => {
      void searchBrain({ key: dashboardKey, query: term, limit: 8 })
        .then((results) => { if (current) setRecalled({ term, results }); })
        .catch(() => { if (current) setRecalled({ term, results: [] }); });
    }, 220);
    return () => { current = false; window.clearTimeout(timer); };
  }, [dashboardKey, searchBrain, term]);
  useEffect(() => {
    if (term.length < 2) { setFound(null); return; }
    let current = true;
    const timer = window.setTimeout(() => {
      void searchChats({ key: dashboardKey, search: term })
        .then((results) => { if (current) setFound({ term, results: results.filter((item) => item.snippet) }); })
        .catch(() => { if (current) setFound({ term, results: [] }); });
    }, 220);
    return () => { current = false; window.clearTimeout(timer); };
  }, [dashboardKey, searchChats, term]);

  const run = (action: () => void) => { onOpenChange(false); action(); };
  const needle = term.toLocaleLowerCase();
  const matches = (...texts: string[]) => !needle || texts.some((text) => text.toLocaleLowerCase().includes(needle));
  const themeLabel = `Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme`;
  const actions = [
    { id: "new", label: "New chat", icon: SquarePenIcon, shortcut: shortcutLabel("newChat"), run: () => router.push("/chat") },
    { id: "note", label: "New page", icon: FilePlusIcon, run: () => void createNote({ key: dashboardKey }).then((id) => router.push(noteHref(id))) },
    { id: "theme", label: themeLabel, icon: resolvedTheme === "dark" ? SunIcon : MoonIcon, run: () => setTheme(resolvedTheme === "dark" ? "light" : "dark") },
    { id: "lock", label: "Lock dashboard", icon: LockIcon, run: lock },
  ].filter((action) => matches(action.label, action.id === "theme" ? "theme dark light" : ""));
  const chatHits = (chats ?? []).filter((chat) => matches(chat.title)).slice(0, needle ? 30 : 8);
  const pages = PAGES.filter((page) => matches(page.label));
  const titled = new Set((chats ?? []).map((chat) => chat.id));
  const searching = term.length >= 2 && (found?.term !== term || recalled?.term !== term);
  const shownChats = new Set(chatHits.map((chat) => chat.id));
  const messageHits = (found?.term === term ? found.results : []).filter((item) => titled.has(item.id) && !shownChats.has(item.id));
  // Notes by title as you type; then what memory and notes say, by words and by meaning.
  const noteTitles = (needle ? (notes ?? []).filter((note) => matches(note.title)) : []).slice(0, 5);
  const brainHits = (recalled?.term === term ? recalled.results : []).slice(0, 8);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search Perry" description="Chats, memory, notes, pages and actions" className="sm:max-w-xl">
      <Command loop shouldFilter={false}>
        <CommandInput placeholder="Search chats, memory, notes and pages…" value={search} onValueChange={setSearch} />
        <CommandList className="max-h-[min(60vh,420px)]">
          <CommandEmpty>{searching ? <span className="inline-flex items-center gap-2"><Spinner />Searching…</span> : "Nothing matches."}</CommandEmpty>
          {actions.length > 0 && (
            <CommandGroup heading="Actions">
              {actions.map((action) => (
                <CommandItem key={action.id} value={action.id} onSelect={() => run(action.run)}>
                  <action.icon />{action.label}{action.shortcut && <CommandShortcut>{action.shortcut}</CommandShortcut>}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {chatHits.length > 0 && (
            <CommandGroup heading={needle ? "Chats" : "Recent chats"}>
              {chatHits.map((chat) => (
                <CommandItem key={chat.id} value={`chat-${chat.id}`} onSelect={() => run(() => router.push(`/chat/${chat.id}`))}>
                  <MessageSquareIcon />
                  <span className="truncate">{chat.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {(noteTitles.length > 0 || brainHits.length > 0) && (
            <CommandGroup heading="Brain">
              {noteTitles.map((note) => (
                <CommandItem key={note.id} value={`note-${note.id}`} onSelect={() => run(() => router.push(noteHref(note.id)))}>
                  <FileTextIcon />
                  <span className="grid min-w-0">
                    <span className="truncate">{note.title}</span>
                    {note.preview && <span className="truncate text-xs text-muted-foreground">{note.preview}</span>}
                  </span>
                </CommandItem>
              ))}
              {brainHits.map((hit) => (
                <CommandItem key={hit.id} value={`recalled-${hit.id}`} data-recalled={hit.kind} onSelect={() => run(() => router.push(hrefOf(hit)))}>
                  {hit.page ? <FileTextIcon /> : <BookUserIcon />}
                  <span className="grid min-w-0">
                    <span className="truncate">{hit.text}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {hit.page ? `${hit.page.title}${hit.section ? ` › ${hit.section}` : ""}` : `${MEMORY_KIND[hit.kind]}${hit.day ? ` · ${hit.day}` : ""}`}
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {messageHits.length > 0 && (
            <CommandGroup heading="In messages">
              {messageHits.map((item) => (
                <CommandItem key={item.id} value={`message-${item.id}`} onSelect={() => run(() => router.push(`/chat/${item.id}`))}>
                  <TextSearchIcon />
                  <span className="grid min-w-0">
                    <span className="truncate">{item.title}</span>
                    <span className="truncate text-xs text-muted-foreground">{item.snippet}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {searching && (chatHits.length > 0 || actions.length > 0 || pages.length > 0) && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground" role="status"><Spinner className="size-3" />Searching…</div>
          )}
          {pages.length > 0 && (
            <CommandGroup heading="Go to">
              {pages.map((page) => (
                <CommandItem key={page.href} value={`page-${page.href}`} onSelect={() => run(() => router.push(page.href))}>
                  <page.icon />{page.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
