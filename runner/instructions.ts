import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "./home";

/**
 * Instructions that change during a chat: the owner's profile, USER.md, who
 * the assistant is, the chat's access, the skills that failed to load. A
 * session keeps the instructions it was first given (a Codex thread saves them
 * in its history and ignores new ones on resume; an ACP session had them in its
 * first prompt), so what changed since is told to it, paragraph by paragraph,
 * before the next message.
 */

type Paragraph = { heading: string; text: string };

/** The paragraphs of some instructions, each with the heading it comes under. */
function paragraphs(text: string): Paragraph[] {
  let heading = "";
  const found: Paragraph[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const first = trimmed.split("\n")[0];
    if (/^#{1,6}\s/.test(first)) heading = first;
    found.push({ heading, text: trimmed });
  }
  return found;
}

/** Paragraphs under their headings, each heading once. */
function render(list: Paragraph[], quote = false): string {
  const lines: string[] = [];
  let shown = "";
  for (const { heading, text } of list) {
    if (heading && heading !== shown && !text.startsWith(heading)) lines.push(heading);
    shown = heading;
    lines.push(quote ? text.split("\n").map((line) => `> ${line}`).join("\n") : text);
  }
  return lines.join("\n\n");
}

/**
 * What to tell a session that was given `before` and should now follow `now`:
 * the paragraphs that are new or changed, and those that no longer apply.
 * The same paragraphs in another order are all of them again, since a later
 * one can qualify an earlier one. Null when nothing changed.
 */
export function instructionsUpdate(before: string, now: string): string | null {
  if (before === now) return null;
  const key = (paragraph: Paragraph) => `${paragraph.heading}\n${paragraph.text}`;
  const old = paragraphs(before).map((paragraph) => ({ ...paragraph, key: key(paragraph) }));
  const fresh = paragraphs(now).map((paragraph) => ({ ...paragraph, key: key(paragraph) }));
  const had = new Set(old.map((paragraph) => paragraph.key));
  const has = new Set(fresh.map((paragraph) => paragraph.key));
  const added = fresh.filter((paragraph) => !had.has(paragraph.key));
  const gone = old.filter((paragraph) => !has.has(paragraph.key));
  if (!added.length && !gone.length) {
    const reordered = old.length !== fresh.length || old.some((paragraph, at) => paragraph.key !== fresh[at].key);
    return reordered ? instructionsInFull(now) : null;
  }
  return [
    "# Your instructions changed",
    "Some of your instructions changed since you were given them. What follows is current: where it differs from anything earlier, it wins.",
    added.length ? `## New or changed\n\n${render(added)}` : "",
    gone.length ? `## No longer part of your instructions\n\n${render(gone, true)}` : "",
  ].filter(Boolean).join("\n\n");
}

/** For a session given instructions before Perry kept track of them, or the same ones reordered: all of them, as current. */
export function instructionsInFull(now: string): string {
  return `# Your instructions, as they are now\n\nThese are your current instructions. Where they differ from anything earlier, they win.\n\n${now}`;
}

/**
 * What each Codex thread was last given, kept in Perry's home so it outlives
 * the runner and the app-server, as the thread does.
 */
const file = (thread: string) => join(PATHS.codexInstructions,`${thread.replace(/[^\w.-]/g, "_")}.md`);

export function givenTo(thread: string): string | undefined {
  try { return readFileSync(file(thread), "utf8"); } catch { return undefined; }
}

/** Compacted, a thread may have lost the updates it was told: it is told all of its instructions again next time. */
export function forget(thread: string) {
  rmSync(file(thread), { force: true });
}

export function gave(thread: string, instructions: string) {
  try {
    mkdirSync(PATHS.codexInstructions, { recursive: true });
    writeFileSync(file(thread), instructions, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error(`Could not keep what a Codex thread was told: ${error instanceof Error ? error.message : String(error)}`);
  }
}
