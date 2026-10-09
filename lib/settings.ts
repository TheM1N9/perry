/**
 * Settings' sections, each at /settings/<slug>, in the groups its nav shows
 * them in. Read on the server for the routes and their titles, and in the
 * browser for the nav and the phone's switcher.
 */
export const SETTINGS_GROUPS = [
  { label: "Perry", sections: [
    { slug: "general", label: "General" },
    { slug: "engines", label: "Engines" },
    { slug: "usage", label: "Usage" },
    { slug: "computers", label: "Computers" },
  ] },
  { label: "Permissions", sections: [{ slug: "access", label: "Access & approvals" }] },
  { label: "Reaching you", sections: [
    { slug: "notifications", label: "Notifications" },
    { slug: "telegram", label: "Telegram" },
    { slug: "whatsapp", label: "WhatsApp" },
  ] },
  { label: "Desktop pet", sections: [{ slug: "desktop-pet", label: "Desktop pet" }] },
  { label: "People", sections: [{ slug: "people", label: "People" }] },
  { label: "Security", sections: [
    { slug: "logins", label: "Logins & secrets" },
    { slug: "security", label: "Dashboard key" },
  ] },
  { label: "System", sections: [{ slug: "activity", label: "Activity log" }] },
] as const;

export type SettingsSection = (typeof SETTINGS_GROUPS)[number]["sections"][number]["slug"];

export const SETTINGS_SECTIONS: ReadonlyArray<{ slug: SettingsSection; label: string; group: string }> =
  SETTINGS_GROUPS.flatMap((group) => group.sections.map((section) => ({ ...section, group: group.label })));

export const isSettingsSection = (value: string): value is SettingsSection => SETTINGS_SECTIONS.some((section) => section.slug === value);

/** Where each service key is entered now: beside the thing it unlocks. */
export const KEY_HOMES: Record<string, string> = {
  TELEGRAM_BOT_TOKEN: "/settings/telegram",
  COMPOSIO_API_KEY: "/apps/connectors",
  GEMINI_API_KEY: "/settings/engines",
};

/**
 * Where each of the old Settings tabs (/settings?tab=…) went, for proxy.ts.
 * Keys has no one home: a link naming its key (&key=) goes to that key, and
 * the rest to Logins & secrets, the most of what that tab held.
 */
export function oldSettingsTab(tab?: string, key?: string): string {
  if (tab === "keys" && key && KEY_HOMES[key]) return KEY_HOMES[key];
  const moved: Record<string, string> = {
    general: "/settings/general",
    usage: "/settings/usage",
    keys: "/settings/logins",
    people: "/settings/people",
    shortcuts: "/settings/desktop-pet#shortcuts",
    telegram: "/settings/telegram",
    whatsapp: "/settings/whatsapp",
  };
  return (tab && moved[tab]) || "/settings/general";
}
