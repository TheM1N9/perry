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
  let current: { lines: string[]; item: boolean; fence: string | null } | null = null;
  const close = () => {
    if (!current) return;
    const [first, ...rest] = current.lines;
    const head = current.item ? itemWords(first) : first.trim();
    const body = current.item ? rest.map((line) => line.replace(/^ {1,4}|^\t/, "")) : rest.map((line) => line.trimEnd());
    const text = [head, ...body].join("\n").trim();
    if (text && !COMMENT_ONLY.test(text)) blocks.push({ text, ...(section ? { section } : {}) });
    current = null;
  };
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (current?.fence) {
      current.lines.push(line);
      if (FENCE.exec(line)?.[1]?.[0] === current.fence && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(line)) close();
      continue;
    }
    const fence = FENCE.exec(line)?.[1];
    if (fence) {
      close();
      current = { lines: [line], item: false, fence: fence[0] };
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
      current = { lines: [line], item: true, fence: null };
      continue;
    }
    if (current) { current.lines.push(line); continue; }
    current = { lines: [line], item: false, fence: null };
  }
  close();
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
export function reconcile<Id>(rows: Array<{ id: Id; text: string; order?: number }>, blocks: Block[]): Plan<Id> {
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
  blocks.forEach((block, at) => {
    const index = claimed[at];
    if (index !== undefined) { plan.keep.push({ id: ordered[index].id, block, order: at }); return; }
    // A changed line: an unclaimed line between the nearest unchanged ones before and after it.
    let low = -1;
    for (let back = at - 1; back >= 0; back--) if (claimed[back] !== undefined) { low = claimed[back]!; break; }
    let high = ordered.length;
    for (let next = at + 1; next < blocks.length; next++) if (claimed[next] !== undefined) { high = claimed[next]!; break; }
    for (let index = low + 1; index < high; index++) {
      if (used.has(index)) continue;
      used.add(index);
      plan.edit.push({ id: ordered[index].id, block, order: at });
      return;
    }
    plan.add.push({ block, order: at });
  });
  ordered.forEach((row, index) => { if (!used.has(index)) plan.drop.push(row.id); });
  return plan;
}

/** A line's words cut short for a list or a search result. */
export function snippet(text: string, width = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > width ? `${flat.slice(0, width - 1).trimEnd()}…` : flat;
}
