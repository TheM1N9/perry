"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  ActivityIcon, BookUserIcon, CableIcon, InboxIcon, KeyRoundIcon, ListChecksIcon, LockIcon, MessageSquareIcon,
  MonitorIcon, MoonIcon, SettingsIcon, SquarePenIcon, SunIcon, TextSearchIcon,
} from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import { useAction, useQuery } from "@/client/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useSession } from "@/lib/session";
import {
  Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut,
} from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";

export const PaletteContext = createContext<{ open: () => void }>({ open: () => {} });
export const usePalette = () => useContext(PaletteContext);

const PAGES = [
  { href: "/inbox", label: "Needs you", icon: InboxIcon },
  { href: "/work", label: "Work", icon: ListChecksIcon },
  { href: "/memory", label: "Memory", icon: BookUserIcon },
  { href: "/connectors", label: "Connectors", icon: CableIcon },
  { href: "/computer", label: "Computer", icon: MonitorIcon },
  { href: "/activity", label: "Activity", icon: ActivityIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
  { href: "/settings?tab=keys", label: "Keys", icon: KeyRoundIcon },
];

type Found = { id: Id<"conversations">; title: string; snippet: string };

/**
 * ⌘K: every chat by title, what was said in them, every page, and the few
 * things you do from anywhere. Titles filter as you type; message text is
 * searched on the server once you pause.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { dashboardKey, lock } = useSession();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const chats = useQuery(api.dashboard.listChats, open ? { key: dashboardKey } : "skip");
  const searchChats = useAction(api.dashboard.searchChats);
  const [search, setSearch] = useState("");
  const [found, setFound] = useState<{ term: string; results: Found[] } | null>(null);
  const term = search.trim();

  useEffect(() => { if (!open) { setSearch(""); setFound(null); } }, [open]);
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
    { id: "new", label: "New chat", icon: SquarePenIcon, shortcut: "⇧⌘O", run: () => router.push("/chat") },
    { id: "theme", label: themeLabel, icon: resolvedTheme === "dark" ? SunIcon : MoonIcon, run: () => setTheme(resolvedTheme === "dark" ? "light" : "dark") },
    { id: "lock", label: "Lock dashboard", icon: LockIcon, run: lock },
  ].filter((action) => matches(action.label, action.id === "theme" ? "theme dark light" : ""));
  const chatHits = (chats ?? []).filter((chat) => matches(chat.title)).slice(0, needle ? 30 : 8);
  const pages = PAGES.filter((page) => matches(page.label));
  const titled = new Set((chats ?? []).map((chat) => chat.id));
  const searching = term.length >= 2 && found?.term !== term;
  const shownChats = new Set(chatHits.map((chat) => chat.id));
  const messageHits = (found?.term === term ? found.results : []).filter((item) => titled.has(item.id) && !shownChats.has(item.id));

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search Perry" description="Chats, pages and actions" className="sm:max-w-xl">
      <Command loop shouldFilter={false}>
        <CommandInput placeholder="Search chats, pages and actions…" value={search} onValueChange={setSearch} />
        <CommandList className="max-h-[min(60vh,420px)]">
          <CommandEmpty>{searching ? <span className="inline-flex items-center gap-2"><Spinner />Searching messages…</span> : "Nothing matches."}</CommandEmpty>
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
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground" role="status"><Spinner className="size-3" />Searching messages…</div>
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
