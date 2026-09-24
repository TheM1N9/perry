/** Every page of the dashboard, in sidebar order. Shared by the client shell and the server routes. */
export const SECTIONS = [
  { id: "chat", label: "Chat", icon: "chat", description: "" },
  { id: "work", label: "Work", icon: "work", description: "Scheduled jobs, tasks, goals, and the pages Perry watches for you." },
  { id: "computer", label: "Computer", icon: "computer", description: "Where Perry runs commands, and the machines connected to it." },
  { id: "connectors", label: "Connectors", icon: "plug", description: "Accounts Perry can use on your behalf, with your permission." },
  { id: "memory", label: "Memory", icon: "memory", description: "What Perry has saved about you, and the place to correct it." },
  { id: "activity", label: "Activity", icon: "activity", description: "Every run, with its tools, tokens, timings, and errors." },
  { id: "settings", label: "Settings", icon: "settings", description: "Your Codex account and how Perry answers when your computer is offline." },
  { id: "keys", label: "Keys", icon: "key", description: "Service credentials this installation uses. Saved keys are never shown again." },
  { id: "setup", label: "Setup", icon: "link", description: "Pair Perry with your Telegram account so it knows who it works for." },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];
