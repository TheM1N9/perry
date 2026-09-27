/**
 * Keyboard shortcuts the owner can change, on the dashboard's Settings page.
 * Pure functions with no server imports: the dashboard, the desktop pet's page
 * and the backend all use them.
 *
 * A shortcut is written as an Electron accelerator ("CommandOrControl+Shift+Space"),
 * the one form both the browser and the pet's global hotkey (pet/voice.js)
 * understand. CommandOrControl is ⌘ on a Mac and Ctrl elsewhere.
 */

export const SHORTCUTS = {
  talk: {
    label: "Talk to Perry",
    description: "Anywhere on this computer, with the desktop pet running: hold, speak and let go, or tap, speak and tap again.",
    default: "CommandOrControl+Shift+Space",
    global: true,
  },
  look: {
    label: "Show Perry the screen",
    description: "Anywhere on this computer, with the desktop pet running: a picture of the window you're in goes into his chat, for you to check and ask about.",
    default: "CommandOrControl+Alt+Shift+Space",
    global: true,
  },
  palette: {
    label: "Search and commands",
    description: "On the dashboard: chats, pages and actions.",
    default: "CommandOrControl+K",
    global: false,
  },
  newChat: {
    label: "New chat",
    description: "On the dashboard.",
    default: "CommandOrControl+Shift+O",
    global: false,
  },
} as const;

export type ShortcutId = keyof typeof SHORTCUTS;
export const SHORTCUT_IDS = Object.keys(SHORTCUTS) as ShortcutId[];
export type Shortcuts = Record<ShortcutId, string>;

const MODIFIERS = ["CommandOrControl", "Control", "Alt", "Shift", "Super"] as const;
type Modifier = (typeof MODIFIERS)[number];

/** Keys by KeyboardEvent.code, which is where the key is rather than what the layout prints on it. */
const KEYS: Record<string, string> = {
  Space: "Space", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert", Enter: "Enter",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Semicolon: ";", Equal: "=", Comma: ",", Minus: "-", Period: ".", Slash: "/", Backquote: "`",
  BracketLeft: "[", Backslash: "\\", BracketRight: "]", Quote: "'",
};
const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

function keyOf(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (FUNCTION_KEY.test(code)) return code;
  return KEYS[code] ?? null;
}

type Parsed = { modifiers: Set<Modifier>; key: string };

function parse(accelerator: string): Parsed | null {
  const parts = accelerator.split("+");
  // "+" itself is not offered, so a trailing empty part is a malformed string.
  const key = parts.pop();
  if (!key) return null;
  const modifiers = new Set<Modifier>();
  for (const part of parts) {
    if (!(MODIFIERS as readonly string[]).includes(part) || modifiers.has(part as Modifier)) return null;
    modifiers.add(part as Modifier);
  }
  const known = FUNCTION_KEY.test(key) || /^[A-Z0-9]$/.test(key) || Object.values(KEYS).includes(key);
  return known ? { modifiers, key } : null;
}

/**
 * Why a shortcut cannot be used, or null when it can. A key needs a modifier
 * with it, except the function keys, or typing would set it off; and Shift
 * alone is still typing.
 */
export function problemWith(accelerator: string): string | null {
  const parsed = parse(accelerator);
  if (!parsed) return "That is not a key combination Perry knows.";
  if (FUNCTION_KEY.test(parsed.key)) return null;
  const others = [...parsed.modifiers].filter((modifier) => modifier !== "Shift");
  if (!others.length) return "Hold Ctrl, Alt or ⌘ with it, so it doesn't go off while you type.";
  return null;
}

/** What a key press makes, or null while only modifiers are down. */
export function fromEvent(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, mac: boolean): string | null {
  const key = keyOf(event.code);
  if (!key) return null;
  const parts: string[] = [];
  // The platform's own command key is CommandOrControl, so a shortcut set on one computer means the same on the other.
  if (mac ? event.metaKey : event.ctrlKey) parts.push("CommandOrControl");
  if (mac && event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (!mac && event.metaKey) parts.push("Super");
  return [...parts, key].join("+");
}

/** Whether a key press is this shortcut. */
export function matches(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, accelerator: string, mac: boolean): boolean {
  return fromEvent(event, mac) === accelerator;
}

const MAC_SYMBOL: Record<string, string> = { CommandOrControl: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧", Super: "⌘" };
const MAC_ORDER = ["Control", "Alt", "Shift", "CommandOrControl", "Super"];
const NAME: Record<string, string> = { CommandOrControl: "Ctrl", Control: "Ctrl", Alt: "Alt", Shift: "Shift", Super: "Win" };

/** How a shortcut reads on this computer: "⇧⌘Space" on a Mac, ["Ctrl", "Shift", "Space"] elsewhere. */
export function keysOf(accelerator: string, mac: boolean): string[] {
  const parsed = parse(accelerator);
  if (!parsed) return [accelerator];
  const key = parsed.key === "Up" ? "↑" : parsed.key === "Down" ? "↓" : parsed.key === "Left" ? "←" : parsed.key === "Right" ? "→" : parsed.key;
  if (mac) return [...MAC_ORDER.filter((modifier) => parsed.modifiers.has(modifier as Modifier)).map((modifier) => MAC_SYMBOL[modifier]), key];
  return [...[...parsed.modifiers].map((modifier) => NAME[modifier]), key];
}

export function describe(accelerator: string, mac: boolean): string {
  return keysOf(accelerator, mac).join(mac ? "" : "+");
}

/** The shortcuts in force: the owner's, where set, over the defaults. */
export function resolve(saved: Partial<Record<string, string>> | undefined): Shortcuts {
  return Object.fromEntries(SHORTCUT_IDS.map((id) => [id, saved?.[id] ?? SHORTCUTS[id].default])) as Shortcuts;
}
