/**
 * What Perry is doing, in a few words, for the desktop pet: each step of a
 * turn's trace (runSpans) as a phrase and a pose, and a finished turn as a
 * line saying what it did. Pure functions with no server imports.
 *
 * Only what the trace already keeps is used, and the trace hides saved login
 * values (vault.ts), so nothing here can show one.
 */

/** How the platypus holds himself for a step: the prop he shows. */
export type Pose = "thinking" | "reading" | "typing" | "searching" | "running" | "drawing" | "remembering" | "waiting";
export type Step = { label: string; pose: Pose };

type Span = { kind: string; name: string; input?: string };

/** "gmail" from GMAIL_FETCH_EMAILS, "Google Calendar" from GOOGLECALENDAR_…; for "Using Gmail". */
const APP_NAMES: Record<string, string> = {
  GMAIL: "Gmail", GOOGLECALENDAR: "Google Calendar", GOOGLEDRIVE: "Google Drive", GOOGLEDOCS: "Google Docs", GOOGLESHEETS: "Google Sheets",
  OUTLOOK: "Outlook", GITHUB: "GitHub", SLACK: "Slack", NOTION: "Notion", LINEAR: "Linear", TWITTER: "X", YOUTUBE: "YouTube",
};
function appOf(slug: string): string {
  const prefix = slug.split("_")[0] ?? slug;
  return APP_NAMES[prefix.toUpperCase()] ?? prefix.charAt(0).toUpperCase() + prefix.slice(1).toLowerCase();
}

const short = (text: string, max = 44) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** A tool call's arguments, as the trace kept them (JSON, maybe cut short). */
function args(span: Span): Record<string, unknown> {
  try { return JSON.parse(span.input ?? "") as Record<string, unknown>; } catch { return {}; }
}

/** The command inside a shell wrapper: `powershell.exe -Command "git status"` is `git status`. */
function innerCommand(command: string): string {
  const inner = /(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+\s+)*?-Command\s+([\s\S]+)$/i.exec(command)?.[1]
    ?? /(?:^|\/)(?:ba|z)?sh\s+-l?c\s+([\s\S]+)$/.exec(command)?.[1];
  return (inner ?? command).trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
}

function host(url: unknown): string {
  try { return new URL(String(url)).hostname.replace(/^www\./, ""); } catch { return "a page"; }
}

/** Perry's own tools (convex/tools.ts), as the owner would say what it is doing. */
const OWN_TOOLS: Record<string, (input: Record<string, unknown>) => Step> = {
  recall: () => ({ label: "Checking what I remember", pose: "remembering" }),
  remember: () => ({ label: "Noting that down", pose: "remembering" }),
  read_memory: () => ({ label: "Reading my notes", pose: "remembering" }),
  forget: () => ({ label: "Forgetting that", pose: "remembering" }),
  update_user_md: () => ({ label: "Updating what I know about you", pose: "remembering" }),
  update_identity: () => ({ label: "Changing how I come across", pose: "remembering" }),
  save_secret: () => ({ label: "Putting that in Logins & secrets", pose: "typing" }),
  list_secrets: () => ({ label: "Looking through your logins", pose: "reading" }),
  use_secret: () => ({ label: "Getting a saved login", pose: "reading" }),
  search_chats: () => ({ label: "Looking through your chats", pose: "searching" }),
  read_chat: () => ({ label: "Reading an earlier chat", pose: "reading" }),
  create_job: () => ({ label: "Scheduling that", pose: "typing" }),
  update_job: () => ({ label: "Changing a schedule", pose: "typing" }),
  list_jobs: () => ({ label: "Looking at your schedules", pose: "reading" }),
  run_job: () => ({ label: "Starting a schedule", pose: "running" }),
  delete_job: () => ({ label: "Removing a schedule", pose: "typing" }),
  add_todo: () => ({ label: "Adding a to-do", pose: "typing" }),
  list_todos: () => ({ label: "Looking at your to-dos", pose: "reading" }),
  update_todo: () => ({ label: "Updating a to-do", pose: "typing" }),
  delete_todo: () => ({ label: "Removing a to-do", pose: "typing" }),
  read_page: (input) => ({ label: `Reading ${host(input.url)}`, pose: "reading" }),
  list_connectors: () => ({ label: "Checking your connected apps", pose: "reading" }),
  find_action: (input) => {
    const toolkit = Array.isArray(input.toolkits) && typeof input.toolkits[0] === "string" ? input.toolkits[0] : undefined;
    return { label: toolkit ? `Finding the way into ${appOf(toolkit)}` : "Finding the right app", pose: "searching" };
  },
  run_action: (input) => ({ label: typeof input.slug === "string" ? `Using ${appOf(input.slug)}` : "Using a connected app", pose: "running" }),
  status_report: () => ({ label: "Checking on your work", pose: "reading" }),
  start_task: () => ({ label: "Making a plan", pose: "typing" }),
  set_plan: () => ({ label: "Making a plan", pose: "typing" }),
  finish_task: () => ({ label: "Wrapping up the plan", pose: "typing" }),
  set_goal: () => ({ label: "Setting up your goal", pose: "typing" }),
  update_goal: () => ({ label: "Updating your goal", pose: "typing" }),
  watch_page: (input) => ({ label: `Setting up a watch on ${host(input.url)}`, pose: "typing" }),
  update_watch: () => ({ label: "Changing a watch", pose: "typing" }),
  delete_watch: () => ({ label: "Removing a watch", pose: "typing" }),
  check_watches: () => ({ label: "Checking your watches", pose: "reading" }),
  share_file: (input) => ({ label: typeof input.path === "string" ? `Sending you ${short(baseName(input.path), 32)}` : "Sending you a file", pose: "running" }),
};

/** One trace step, as the pet says it. */
export function describeStep(span: Span): Step {
  switch (span.kind) {
    case "command": return { label: `Running ${short(innerCommand(span.name))}`, pose: "running" };
    case "fileChange": {
      const files = span.name.split(", ").filter(Boolean);
      return { label: files.length > 1 ? `Editing ${files.length} files` : `Editing ${short(baseName(files[0] ?? "a file"), 36)}`, pose: "typing" };
    }
    case "webSearch": return { label: span.name && span.name !== "web search" ? `Searching the web for “${short(span.name, 32)}”` : "Searching the web", pose: "searching" };
    case "imageGeneration": return { label: "Drawing an image", pose: "drawing" };
    case "reasoning": return { label: "Thinking it through", pose: "thinking" };
    case "mcpToolCall": {
      const own = OWN_TOOLS[span.name];
      if (own) return own(args(span));
      return { label: `Using ${short(span.name.split(".")[0] ?? span.name, 30)}`, pose: "running" };
    }
    default: return { label: `Using ${short(span.name, 30)}`, pose: "running" };
  }
}

export const WAITING: Step = { label: "Waiting for you to approve", pose: "waiting" };
export const WRITING: Step = { label: "Writing the reply", pose: "typing" };
export const STARTING: Step = { label: "Thinking", pose: "thinking" };

/** A step that finished between two reports is held up this long. */
const STEP_HOLD_MS = 2_500;

type Shown = { running: boolean; step?: Step & { since: number; live: boolean }; recent?: Step & { since: number; endedAt: number } };

/**
 * The step to show for a turn (dashboard.getActivity): the one it is on, or
 * between steps the one that just finished, held up a moment so a quick one
 * is seen at all. Nothing once the turn is over.
 */
export function shownStep(of: Shown | null | undefined, now: number) {
  return !of?.running || !of.step ? undefined
    : of.step.live || !of.recent || now - of.recent.endedAt > STEP_HOLD_MS ? of.step : of.recent;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a finished turn did, for under its reply: "Ran 3 commands · read 2 pages". Empty when it only answered. */
export function summarize(spans: Span[]): string {
  const commands = spans.filter((span) => span.kind === "command").length;
  const files = new Set(spans.filter((span) => span.kind === "fileChange").flatMap((span) => span.name.split(", "))).size;
  const pages = spans.filter((span) => span.kind === "mcpToolCall" && span.name === "read_page").length;
  const searches = spans.filter((span) => span.kind === "webSearch").length;
  const apps = [...new Set(spans.filter((span) => span.kind === "mcpToolCall" && span.name === "run_action")
    .map((span) => args(span).slug).filter((slug): slug is string => typeof slug === "string").map(appOf))];
  const images = spans.filter((span) => span.kind === "imageGeneration").length;
  const parts = [
    commands && `ran ${count(commands, "command")}`,
    files && `changed ${count(files, "file")}`,
    pages && `read ${count(pages, "page")}`,
    searches && (searches === 1 ? "searched the web" : `searched the web ${searches} times`),
    apps.length && `used ${apps.join(" and ")}`,
    images && `drew ${count(images, "image")}`,
  ].filter((part): part is string => Boolean(part));
  const line = parts.join(" · ");
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : "";
}
