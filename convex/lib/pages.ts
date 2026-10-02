/**
 * A page's lines: the paragraphs, list items and other blocks of its
 * Markdown, each with the heading it sits under. Every line of every page is
 * a row in `memories` (pages.ts), so one search covers what used to be memory
 * and notes, and each line keeps who wrote it, from which chat, and when.
 * Pure functions with no server imports, shared by the server and the browser.
 */

export type Block = {
  /** The block's words: a list item without its marker or checkbox, continuation lines unindented. */
  text: string;
  /** The heading it sits under, as written; none above the first heading. */
  section?: string;
  /** Its first and last line in the page's Markdown, counted from 0. */
  start: number;
  end: number;
};

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^( {0,3})(?:[-*+]|\d{1,9}[.)])(?:\s+|$)/;
const RULE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const COMMENT_ONLY = /^\s*<!--[\s\S]*?-->\s*$/;

/** A heading's words without emphasis or code marks. */
export const headingText = (text: string) => text.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

/** A list item's first line without its marker and checkbox. */
const itemWords = (line: string) => line.replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s*(?:\[[ xX]\]\s+)?/, "");

/**
 * The page's blocks in order. Headings are not lines: they name the section
 * of what follows. A list item, with what is indented under it, is one line;
 * a paragraph, a table or a code block is one line; rules and comments are none.
 */
export function blocksOf(markdown: string): Block[] {
  const blocks: Block[] = [];
  let section: string | undefined;
  let current: { lines: string[]; item: boolean; fence: string | null; start: number } | null = null;
  let at = -1;
  const close = (end = at - 1) => {
    if (!current) return;
    const [first, ...rest] = current.lines;
    const head = current.item ? itemWords(first) : first.trim();
    const body = current.item ? rest.map((line) => line.replace(/^ {1,4}|^\t/, "")) : rest.map((line) => line.trimEnd());
    const text = [head, ...body].join("\n").trim();
    if (text && !COMMENT_ONLY.test(text)) blocks.push({ text, ...(section ? { section } : {}), start: current.start, end });
    current = null;
  };
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    at++;
    const line = raw.replace(/\s+$/, "");
    if (current?.fence) {
      current.lines.push(line);
      if (FENCE.exec(line)?.[1]?.[0] === current.fence && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(line)) close(at);
      continue;
    }
    const fence = FENCE.exec(line)?.[1];
    if (fence) {
      close();
      current = { lines: [line], item: false, fence: fence[0], start: at };
      continue;
    }
    if (!line.trim()) {
      // A blank line inside a list item ends it unless what follows is indented under it; kept simple: it ends it.
      close();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      section = headingText(heading[2]) || undefined;
      continue;
    }
    if (RULE.test(line)) {
      close();
      continue;
    }
    if (ITEM.test(line)) {
      // A nested item belongs to the item above it.
      if (current?.item && /^\s{2,}/.test(line)) { current.lines.push(line); continue; }
      close();
      current = { lines: [line], item: true, fence: null, start: at };
      continue;
    }
    if (current) { current.lines.push(line); continue; }
    current = { lines: [line], item: false, fence: null, start: at };
  }
  close(at);
  return blocks;
}

/** What two lines are compared by: their words, case and spacing aside. */
export const sameKey = (text: string) => text.replace(/\s+/g, " ").trim().toLocaleLowerCase();

export type Plan<Id> = {
  /** Lines that stay, maybe moved or under another heading now. */
  keep: Array<{ id: Id; block: Block; order: number }>;
  /** Lines whose words changed where they stand: the same line, edited. */
  edit: Array<{ id: Id; block: Block; order: number }>;
  add: Array<{ block: Block; order: number }>;
  drop: Id[];
};

/**
 * What a save did to a page's lines. A block with the same words as a line
 * is that line, wherever it moved; a changed block where a line was (between
 * the same unchanged neighbours) is that line edited, so it keeps where it
 * came from; the rest are new lines, and lines with no block left are gone.
 */
export function reconcile<Id>(rows: Array<{ id: Id; text: string; order?: number }>, blocks: Block[], hints?: Map<string, Id>): Plan<Id> {
  const ordered = [...rows].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const free = new Map<string, number[]>();
  ordered.forEach((row, index) => {
    const key = sameKey(row.text);
    free.set(key, [...(free.get(key) ?? []), index]);
  });
  // Unchanged lines first: each block takes the first unclaimed line with its words.
  const claimed: Array<number | undefined> = blocks.map((block) => {
    const list = free.get(sameKey(block.text));
    return list?.length ? list.shift() : undefined;
  });
  const used = new Set(claimed.filter((index): index is number => index !== undefined));
  const plan: Plan<Id> = { keep: [], edit: [], add: [], drop: [] };
  // A changed line: an unclaimed line between the nearest unchanged ones before and after it, that shares most of
  // its words (a rewording, not a new line typed beside it). The closest pairs are taken first.
  const pairs: Array<{ at: number; index: number; score: number }> = [];
  blocks.forEach((block, at) => {
    if (claimed[at] !== undefined) return;
    let low = -1;
    for (let back = at - 1; back >= 0; back--) if (claimed[back] !== undefined) { low = claimed[back]!; break; }
    let high = ordered.length;
    for (let next = at + 1; next < blocks.length; next++) if (claimed[next] !== undefined) { high = claimed[next]!; break; }
    for (let index = low + 1; index < high; index++) {
      if (used.has(index)) continue;
      const score = overlap(block.text, ordered[index].text);
      if (score >= 0.5) pairs.push({ at, index, score });
    }
  });
  const edited = new Map<number, number>();
  // A line changed on purpose (an edit of one memory, a to-do's news) is that line, whatever its new words.
  blocks.forEach((block, at) => {
    const id = claimed[at] === undefined ? hints?.get(sameKey(block.text)) : undefined;
    const index = id === undefined ? -1 : ordered.findIndex((row) => row.id === id);
    if (index >= 0 && !used.has(index)) { edited.set(at, index); used.add(index); }
  });
  for (const pair of pairs.sort((a, b) => b.score - a.score)) {
    if (edited.has(pair.at) || used.has(pair.index)) continue;
    edited.set(pair.at, pair.index);
    used.add(pair.index);
  }
  blocks.forEach((block, at) => {
    const index = claimed[at] ?? edited.get(at);
    if (index === undefined) plan.add.push({ block, order: at });
    else (claimed[at] !== undefined ? plan.keep : plan.edit).push({ id: ordered[index].id, block, order: at });
  });
  ordered.forEach((row, index) => { if (!used.has(index)) plan.drop.push(row.id); });
  return plan;
}

const wordsIn = (text: string) => new Set(text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
/** How much of the shorter of two lines the other has, by words: 1 when one holds all of the other's. */
function overlap(a: string, b: string): number {
  const one = wordsIn(a);
  const two = wordsIn(b);
  if (!one.size || !two.size) return 0;
  let shared = 0;
  for (const word of one) if (two.has(word)) shared++;
  return shared / Math.min(one.size, two.size);
}

/** A line's words cut short for a list or a search result. */
export function snippet(text: string, width = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > width ? `${flat.slice(0, width - 1).trimEnd()}…` : flat;
}

// --- Writing one line ------------------------------------------------------------------------------

/** A memory as a page's line: a list item, with any further lines indented under it. */
export function itemOf(text: string): string {
  const [first, ...rest] = text.trim().replace(/\r\n?/g, "\n").split("\n");
  return [`- ${first}`, ...rest.map((line) => (line.trim() ? `  ${line}` : ""))].join("\n");
}

const splitLines = (content: string) => content.replace(/\r\n?/g, "\n").split("\n");
const tidy = (lines: string[]) => `${lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\s+$/, "")}\n`;

/** The page with one line's words changed where it stands, its list marker kept; null when no line has those words. */
export function replaceLine(content: string, oldText: string, newText: string): string | null {
  const block = blocksOf(content).find((item) => sameKey(item.text) === sameKey(oldText));
  if (!block) return null;
  const lines = splitLines(content);
  const marker = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)/.exec(lines[block.start])?.[1];
  const [first, ...rest] = newText.trim().replace(/\r\n?/g, "\n").split("\n");
  const indent = marker ? " ".repeat(marker.length) : "";
  const fresh = [`${marker ?? ""}${first}`, ...rest.map((line) => (line.trim() ? `${indent}${line}` : ""))];
  lines.splice(block.start, block.end - block.start + 1, ...fresh);
  return tidy(lines);
}

/**
 * The page with several lines replaced by others where the first of them
 * stood (a merge, a section condensed), each new one a line of its own with
 * the first one's marker; null when any old line is not on the page.
 */
export function replaceLines(content: string, oldTexts: string[], newTexts: string[]): string | null {
  const blocks = blocksOf(content);
  const used = new Set<number>();
  const found: Block[] = [];
  for (const text of oldTexts) {
    const index = blocks.findIndex((block, at) => !used.has(at) && sameKey(block.text) === sameKey(text));
    if (index < 0) return null;
    used.add(index);
    found.push(blocks[index]);
  }
  const lines = splitLines(content);
  const first = [...found].sort((a, b) => a.start - b.start)[0];
  const marker = /^(\s*(?:[-*+]|\d{1,9}[.)])\s+)/.exec(lines[first.start])?.[1]?.replace(/\d{1,9}([.)])/, "1$1") ?? "- ";
  const fresh = newTexts.flatMap((text) => {
    const [head, ...rest] = text.trim().replace(/\r\n?/g, "\n").split("\n");
    return [`${marker}${head}`, ...rest.map((line) => (line.trim() ? `${" ".repeat(marker.length)}${line}` : ""))];
  });
  // From the last up, so earlier places stay where they are.
  for (const block of [...found].sort((a, b) => b.start - a.start)) lines.splice(block.start, block.end - block.start + 1, ...(block === first ? fresh : []));
  return tidy(lines);
}

/** The page without one line; null when no line has those words. */
export function removeLine(content: string, text: string): string | null {
  const block = blocksOf(content).find((item) => sameKey(item.text) === sameKey(text));
  if (!block) return null;
  const lines = splitLines(content);
  lines.splice(block.start, block.end - block.start + 1);
  return tidy(lines);
}

// --- Memory as pages --------------------------------------------------------------------------------

/**
 * What a page is. Ordinary pages have no kind. The rest are memory:
 *   about     About me (USER.md, and how the owner likes things done)
 *   remember  Things to remember, in sections; one for everywhere, and one per project
 *   journal   one page per day, what happened (was daily notes); one per day for a project too
 *   person    People/<name>, what Perry knows about someone in the owner's life
 *   chat      what was kept to one chat, out of every other's sight
 */
export type PageKind = "about" | "remember" | "journal" | "person" | "chat";

/** The sections Things to remember starts with; Perry may add others. */
export const REMEMBER_SECTIONS = ["People", "Work", "Health", "Home", "Preferences", "Other"] as const;
/** Where About me keeps standing preferences: how the owner wants things done. */
export const PREFERENCES_SECTION = "How I like things done";

const SECTION_WORDS: Array<[string, RegExp]> = [
  ["Health", /\b(health|doctor|dentist|medic|blood|allerg|diet|vegetarian|vegan|gym|run|running|swim|fitness|sleep|weight|knee|surgery|pill|therapy|workout|yoga)/i],
  ["Work", /\b(work|job|office|client|boss|colleague|team|project|meeting|salary|company|career|deadline|startup|business|manager)/i],
  ["Home", /\b(home|house|flat|apartment|rent|landlord|address|lives? in|moved to|car|garden|kitchen|neighbou?r)/i],
  ["Preferences", /\b(likes?|loves?|hates?|prefers?|favou?rite|enjoys?|dislikes?|can't stand)\b/i],
  ["People", /\b(brother|sister|mother|mom|mum|father|dad|wife|husband|partner|son|daughter|friend|cousin|uncle|aunt|girlfriend|boyfriend|birthday)/i],
];

/**
 * USER.md written whole into About me (the welcome page, update_user_md, a
 * version brought back) keeps the page's "How I like things done" when the
 * new words leave that section out: those are memories, not USER.md's to drop.
 */
export function keepPreferences(text: string, page: string): string {
  const blocks = (content: string) => blocksOf(content).filter((block) => block.section === PREFERENCES_SECTION);
  const kept = blocks(page);
  if (!kept.length || blocks(text).length || /^#{1,6}\s+How I like things done\s*$/im.test(text)) return text;
  const lines = page.replace(/\r\n?/g, "\n").split("\n");
  const body = kept.map((block) => lines.slice(block.start, block.end + 1).join("\n")).join("\n");
  return `${text.trim()}\n\n## ${PREFERENCES_SECTION}\n\n${body}\n`;
}

/** Whether About me has USER.md in it: words outside How I like things done, which a new USER.md would replace. */
export const hasUserMd = (about: string) => blocksOf(about).some((block) => block.section !== PREFERENCES_SECTION);

/** The section of Things to remember a fact goes under when none was named. */
export function sectionFor(text: string, tags: string[] = [], about: string[] = []): string {
  if (about.length) return "People";
  const words = `${tags.join(" ")} ${text}`;
  return SECTION_WORDS.find(([, test]) => test.test(words))?.[0] ?? "Other";
}

/** A journal page's title: "Fri 2 Oct 2026". */
export function journalTitle(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }).replace(/,/g, "");
}

/** A person's name as a page key: what "Datta" and "datta " both are. */
export const personKey = (name: string) => name.replace(/\s+/g, " ").trim().toLocaleLowerCase();

/**
 * The people a memory is about, each once: `about` may hold names one by one
 * or several in one, comma-separated ("Juhi, Aadil, Vivek"), as memories from
 * before people pages do.
 */
export function peopleIn(about?: string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of (about ?? []).flatMap((item) => item.split(","))) {
    const name = part.replace(/\s+/g, " ").trim();
    if (!name || seen.has(personKey(name))) continue;
    seen.add(personKey(name));
    names.push(name);
  }
  return names;
}
