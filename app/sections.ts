/** Every page of the dashboard, in sidebar order. Shared by the client shell and the server routes. */
export const SECTIONS = [
  { id: "chat", label: "Chat", icon: "chat", description: "" },
  { id: "tasks", label: "Tasks", icon: "work", description: "What Perry runs on a schedule, the plans it is working through, your goals, and the pages it watches." },
  { id: "computer", label: "Computer", icon: "computer", description: "Where Perry runs commands, and the machines connected to it." },
  { id: "connectors", label: "Connectors", icon: "plug", description: "Accounts Perry can use on your behalf, with your permission." },
  { id: "memory", label: "Memory", icon: "memory", description: "What Perry has saved about you, and the place to correct it." },
  { id: "activity", label: "Activity", icon: "activity", description: "Every run, with its tools, tokens, timings, and errors." },
  { id: "settings", label: "Settings", icon: "settings", description: "Your Codex account and how Perry answers when your computer is offline." },
  { id: "keys", label: "Keys", icon: "key", description: "Service credentials this installation uses. Saved keys are never shown again." },
  { id: "setup", label: "Setup", icon: "link", description: "Talk to Perry on Telegram too: pair it with your account so it knows who it works for." },
  { id: "profile", label: "Profile", icon: "user", description: "What Perry knows about you, what it can reach, and how it's set up." },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];
