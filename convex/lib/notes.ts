/**
 * Notes' rules that the server, Perry's tools and the browser share: their
 * limits, where a note is linked, and editing one section of a note's
 * Markdown. Pure functions with no server imports.
 */

// Adapted from CopilotKit/OpenDots (MIT): src/server/pages.ts (the title and content limits)
export const TITLE_LIMIT = 160;
export const CONTENT_LIMIT = 100_000;
/** The note "/note <words>" and the pet's quick note add to. */
export const INBOX_TITLE = "Inbox";

/** Where a note opens in the dashboard; Perry links it so in a web chat. */
export const noteHref = (id: string) => `/notes/${id}`;

export function cleanTitle(title: string): string {
  return title.replace(/\s+/g, " ").trim().slice(0, TITLE_LIMIT) || "Untitled";
}

/** A first title for words with none: their first line, cut short. */
export function titleFrom(text: string): string {
  // The first line with words, without its block marker or emphasis; an underscore inside a word (search_notes) stays.
  const line = text.split("\n")
    .map((part) => part.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "").replace(/\*\*|`|(^|\W)_+|_+(?=\W|$)/g, "$1").trim())
    .find(Boolean) ?? "";
  return cleanTitle(line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line);
}

/** A page of memory (pages.ts) holds every memory of its kind, so it may grow far longer than a note. */
export const MEMORY_PAGE_LIMIT = 1_000_000;

export function tooLong(content: string, limit = CONTENT_LIMIT): string | null {
  return content.length > limit ? `A page holds up to ${limit.toLocaleString("en-US")} characters; this one would have ${content.length.toLocaleString("en-US")}.` : null;
}

/** Text added to the end of a note, after a blank line. */
export function appended(content: string, text: string): string {
  const body = content.replace(/\s+$/, "");
  const added = text.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
  return body ? `${body}\n\n${added}\n` : `${added}\n`;
}

type Heading = { line: number; level: number; text: string };

const norm = (text: string) => text.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().toLocaleLowerCase();

/** The Markdown headings of a note, outside code blocks. */
export function headingsOf(content: string): Heading[] {
  const found: Heading[] = [];
  let fence: string | null = null;
  content.split("\n").forEach((line, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) found.push({ line: index, level: heading[1].length, text: heading[2] });
  });
  return found;
}

/**
 * One section of a note, by its heading's words (any level, case aside): its
 * body replaced, or text added at its end. A section runs to the next heading
 * of its level or above. Added to a section the note lacks, it becomes a new
 * section at the end; replacing one it lacks is refused with the headings
 * there are, so a misspelt heading never makes a second copy.
 */
export function editSection(content: string, heading: string, text: string, mode: "append" | "replace"): { content: string } | { error: string; headings: string[] } {
  const headings = headingsOf(content);
  const wanted = norm(heading.replace(/^#+\s*/, ""));
  const at = headings.findIndex((item) => norm(item.text) === wanted);
  if (at < 0) {
    if (mode === "replace") return { error: `This note has no section "${heading}".`, headings: headings.map((item) => item.text) };
    return { content: appended(content, `## ${heading.replace(/^#+\s*/, "").trim()}\n\n${text.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "")}`) };
  }
  const lines = content.split("\n");
  const start = headings[at];
  const next = headings.slice(at + 1).find((item) => item.level <= start.level);
  const end = next ? next.line : lines.length;
  // Blank lines at either end go; inside, the words are kept exactly as they are.
  const edges = (part: string) => part.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
  const body = edges(lines.slice(start.line + 1, end).join("\n"));
  const fresh = edges(text);
  const section = `${lines[start.line]}\n\n${mode === "append" && body ? `${body}\n\n${fresh}` : fresh}`;
  const before = lines.slice(0, start.line).join("\n").replace(/\s+$/, "");
  const after = edges(lines.slice(end).join("\n"));
  return { content: `${[before, section, after].filter(Boolean).join("\n\n")}\n` };
}
