"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { ActivityIcon, BellIcon, ChartNoAxesCombinedIcon, CpuIcon, GlobeIcon, KeyRoundIcon, LockKeyholeIcon, MessageCircleIcon, MonitorIcon, PawPrintIcon, SendIcon, Settings2Icon, ShieldCheckIcon, UsersIcon } from "lucide-react";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsSection } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Page, PageInPage } from "./common";

const SECTION_ICONS = {
  general: Settings2Icon, engines: CpuIcon, usage: ChartNoAxesCombinedIcon, computers: MonitorIcon,
  access: ShieldCheckIcon, notifications: BellIcon, telegram: SendIcon, whatsapp: MessageCircleIcon,
  "desktop-pet": PawPrintIcon, people: UsersIcon, logins: KeyRoundIcon, security: LockKeyholeIcon,
  internet: GlobeIcon, activity: ActivityIcon,
} satisfies Record<SettingsSection, typeof Settings2Icon>;

/**
 * Settings, one page: its sections in groups down the left, and the one open
 * beside them. On a phone the list is a switcher above the section instead.
 * Each section has its own address, /settings/<section>.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const selected = SETTINGS_SECTIONS.find((section) => pathname === `/settings/${section.slug}`);
  const current = selected?.slug;
  return (
    <Page title="Settings" wide>
      <div className="md:grid md:grid-cols-[12rem_minmax(0,1fr)] md:gap-8 lg:gap-10">
        <SectionNav current={current} />
        <SectionSwitcher current={current} />
        <div className="min-w-0 max-w-2xl text-sm [&_input]:text-base [&_textarea]:text-base md:[&_input]:text-sm md:[&_textarea]:text-sm">
          <h2 className="mb-6 hidden text-xl font-semibold tracking-tight md:block">{selected?.label}</h2>
          <PageInPage variant="settings">{children}</PageInPage>
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
      <div className="sticky top-16 grid max-h-[calc(100dvh-5rem)] gap-4 overflow-y-auto pb-4">
        {SETTINGS_GROUPS.map((group) => {
          const id = `settings-group-${group.label.toLowerCase().replace(/\W+/g, "-")}`;
          return (
            <div key={group.label}>
              <p id={id} className="mb-1 px-2 text-xs font-medium text-muted-foreground">{group.label}</p>
              <ul aria-labelledby={id} className="grid gap-0.5">
                {group.sections.map((section) => {
                  const Icon = SECTION_ICONS[section.slug];
                  return (
                    <li key={section.slug}>
                      <Link href={`/settings/${section.slug}`} aria-current={section.slug === current ? "page" : undefined}
                        className={cn("flex min-h-10 items-center gap-2.5 rounded-md px-2 text-sm font-medium text-muted-foreground outline-none transition-colors duration-150 hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none [@media(pointer:coarse)]:min-h-11",
                          section.slug === current && "bg-muted text-foreground")}>
                        <Icon aria-hidden className="size-4 shrink-0 stroke-[1.75]" />
                        {section.label}
                      </Link>
                    </li>
                  );
                })}
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
    <div className="mb-6 md:hidden">
      <Select modal={false} items={SETTINGS_SECTIONS.map((section) => ({ value: section.slug, label: section.label }))} value={current ?? null}
        onValueChange={(value) => { if (value && value !== current) router.push(`/settings/${value}`); }}>
        <SelectTrigger aria-label="Settings section" className="min-h-11 w-full"><SelectValue placeholder="Choose a section" /></SelectTrigger>
        <SelectContent>
          {SETTINGS_GROUPS.map((group) => (
            <SelectGroup key={group.label}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.sections.map((section) => {
                const Icon = SECTION_ICONS[section.slug];
                return <SelectItem key={section.slug} value={section.slug} className="min-h-11"><Icon aria-hidden className="size-4" />{section.label}</SelectItem>;
              })}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
