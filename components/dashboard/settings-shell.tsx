"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Page, PageInPage } from "./common";

/**
 * Settings, one page: its sections in groups down the left, and the one open
 * beside them. On a phone the list is a switcher above the section instead.
 * Each section has its own address, /settings/<section>.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const current = SETTINGS_SECTIONS.find((section) => pathname === `/settings/${section.slug}`)?.slug;
  return (
    <Page title="Settings" wide>
      <div className="md:grid md:grid-cols-[11rem_minmax(0,1fr)] md:gap-10 lg:gap-14">
        <SectionNav current={current} />
        <SectionSwitcher current={current} />
        <div className="max-w-3xl min-w-0">
          <PageInPage>{children}</PageInPage>
        </div>
      </div>
    </Page>
  );
}

/**
 * The sections as plain words under their group's name, the open one marked.
 * Tab goes through them as links do; the arrow keys, Home and End move along
 * them too. A group of one section named as the group shows just the section.
 */
function SectionNav({ current }: { current?: string }) {
  const nav = useRef<HTMLElement>(null);
  const move = (event: KeyboardEvent) => {
    const links = [...(nav.current?.querySelectorAll("a") ?? [])];
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    const to = event.key === "ArrowDown" ? at + 1 : event.key === "ArrowUp" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : null;
    if (to === null || at < 0) return;
    event.preventDefault();
    links[Math.max(0, Math.min(links.length - 1, to))]?.focus();
  };
  return (
    <nav ref={nav} aria-label="Settings" className="max-md:hidden" onKeyDown={move}>
      <div className="sticky top-16 grid gap-5">
        {SETTINGS_GROUPS.map((group) => {
          const named = group.sections.length > 1 || group.sections[0].label !== group.label;
          const id = `settings-group-${group.label.toLowerCase().replace(/W+/g, "-")}`;
          return (
            <div key={group.label}>
              {named && <p id={id} className="mb-1 px-2 text-xs font-medium text-muted-foreground">{group.label}</p>}
              <ul aria-labelledby={named ? id : undefined} aria-label={named ? undefined : group.label} className="grid gap-0.5">
                {group.sections.map((section) => (
                  <li key={section.slug}>
                    <Link href={`/settings/${section.slug}`} aria-current={section.slug === current ? "page" : undefined}
                      className={cn("block rounded-md px-2 py-1.5 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
                        section.slug === current && "bg-muted font-medium text-foreground")}>
                      {section.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}

/** On a phone: the open section, and a list of the others in their groups to go to. */
function SectionSwitcher({ current }: { current?: string }) {
  const router = useRouter();
  return (
    <div className="mb-8 md:hidden">
      <Select modal={false} items={SETTINGS_SECTIONS.map((section) => ({ value: section.slug, label: section.label }))} value={current ?? null}
        onValueChange={(value) => { if (value && value !== current) router.push(`/settings/${value}`); }}>
        <SelectTrigger aria-label="Settings section" className="h-10 w-full"><SelectValue placeholder="Choose a section" /></SelectTrigger>
        <SelectContent>
          {SETTINGS_GROUPS.map((group) => (
            <SelectGroup key={group.label}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.sections.map((section) => <SelectItem key={section.slug} value={section.slug}>{section.label}</SelectItem>)}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
