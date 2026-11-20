import { Fragment, type ReactNode } from "react";

/**
 * Perry's held edit to a Riff document, shown in the page as a diff: removed
 * words struck through, added words tinted, the rest as written. Blocks
 * (paragraphs, lists, headings) are matched first; a changed block of the same
 * shape is compared word by word, and anything else reads as one block gone
 * and another added. Rendered into the same `prose-note` structure the editor
 * uses, so the page does not shift when review starts or ends.
 */

type Op<T> = { type: "same" | "del" | "ins"; value: T };

/** The longest common subsequence's edit script; past `limit` cells it gives up and replaces everything. */
function script<T>(a: T[], b: T[], limit = 4_000_000): Op<T>[] {
  if (a.length * b.length > limit) return [...a.map((value) => ({ type: "del" as const, value })), ...b.map((value) => ({ type: "ins" as const, value }))];
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const ops: Op<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ type: "same", value: a[i] }); i++; j++; }
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) ops.push({ type: "del", value: a[i++] });
    else ops.push({ type: "ins", value: b[j++] });
  }
  while (i < a.length) ops.push({ type: "del", value: a[i++] });
  while (j < b.length) ops.push({ type: "ins", value: b[j++] });
  return ops;
}

const blocksOf = (markdown: string) => markdown.replace(/\r\n/g, "\n").split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);

type Shape = "p" | "h1" | "h2" | "h3" | "ul" | "ol" | "task" | "quote" | "hr";
type Line = { marker: string; text: string };

function shapeOf(block: string): { shape: Shape; lines: Line[] } {
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(block)) return { shape: "hr", lines: [] };
  const heading = block.match(/^(#{1,6})\s+([\s\S]*)$/);
  if (heading) return { shape: heading[1].length === 1 ? "h1" : heading[1].length === 2 ? "h2" : "h3", lines: [{ marker: "", text: heading[2] }] };
  const lines = block.split("\n");
  const all = (pattern: RegExp) => lines.every((line) => pattern.test(line));
  if (all(/^\s*[-*+]\s+\[[ xX]\]\s+/)) return { shape: "task", lines: lines.map((line) => { const m = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/)!; return { marker: m[1].trim() ? "x" : "", text: m[2] }; }) };
  if (all(/^\s*[-*+]\s+/)) return { shape: "ul", lines: lines.map((line) => ({ marker: "", text: line.replace(/^\s*[-*+]\s+/, "") })) };
  if (all(/^\s*\d+[.)]\s+/)) return { shape: "ol", lines: lines.map((line) => ({ marker: "", text: line.replace(/^\s*\d+[.)]\s+/, "") })) };
  if (all(/^>\s?/)) return { shape: "quote", lines: [{ marker: "", text: lines.map((line) => line.replace(/^>\s?/, "")).join(" ") }] };
  return { shape: "p", lines: [{ marker: "", text: lines.join(" ") }] };
}

/** What a line reads as, without Markdown's marks: emphasis, code ticks and link targets go, the words stay. */
const plain = (text: string) => text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "").replace(/(^|\W)[*_](?=\S)|(?<=\S)[*_](?=\W|$)/g, "$1");

const Del = ({ children }: { children: ReactNode }) => <del className="text-muted-foreground decoration-muted-foreground/70">{children}</del>;
const Ins = ({ children }: { children: ReactNode }) => <ins className="rounded-[3px] bg-primary/12 text-foreground no-underline [box-decoration-break:clone] [-webkit-box-decoration-break:clone]">{children}</ins>;

function words(before: string, after: string): ReactNode {
  const ops = script(plain(before).split(/(\s+)/).filter(Boolean), plain(after).split(/(\s+)/).filter(Boolean), 400_000);
  // Runs of the same kind read as one mark; a lone space between two changes joins them.
  const runs: Array<{ type: Op<string>["type"]; text: string }> = [];
  for (const op of ops) {
    const last = runs.at(-1);
    if (last && last.type === op.type) last.text += op.value;
    else runs.push({ type: op.type, text: op.value });
  }
  return runs.map((run, index) => run.type === "same" ? <Fragment key={index}>{run.text}</Fragment> : run.type === "del" ? <Del key={index}>{run.text}</Del> : <Ins key={index}>{run.text}</Ins>);
}

function Block({ shape, lines, mark }: { shape: Shape; lines: Array<{ marker: string; content: ReactNode }>; mark?: "del" | "ins" }) {
  const wrap = (content: ReactNode) => mark === "del" ? <Del>{content}</Del> : mark === "ins" ? <Ins>{content}</Ins> : content;
  if (shape === "hr") return <hr className={mark === "ins" ? "border-primary/40" : mark === "del" ? "border-dashed" : undefined} />;
  if (shape === "ul" || shape === "ol" || shape === "task") {
    const List = shape === "ol" ? "ol" : "ul";
    return <List>{lines.map((line, index) => <li key={index}>{shape === "task" && <span aria-hidden className="mr-2 text-muted-foreground">{line.marker ? "☑" : "☐"}</span>}{wrap(line.content)}</li>)}</List>;
  }
  const content = wrap(lines[0]?.content);
  if (shape === "quote") return <blockquote>{content}</blockquote>;
  if (shape === "h1") return <h1>{content}</h1>;
  if (shape === "h2") return <h2>{content}</h2>;
  if (shape === "h3") return <h3>{content}</h3>;
  return <p>{content}</p>;
}

/** A list's items matched one by one: kept, changed word by word, gone or added. */
function listLines(before: Line[], after: Line[]): Array<{ marker: string; content: ReactNode }> {
  const ops = script(before.map((line) => line.text), after.map((line) => line.text));
  const out: Array<{ marker: string; content: ReactNode }> = [];
  for (let index = 0; index < ops.length;) {
    if (ops[index].type === "same") { out.push({ marker: "", content: plain(ops[index].value) }); index++; continue; }
    const gone: string[] = [];
    const added: string[] = [];
    while (index < ops.length && ops[index].type !== "same") (ops[index].type === "del" ? gone : added).push(ops[index++].value);
    const paired = Math.min(gone.length, added.length);
    for (let k = 0; k < paired; k++) out.push({ marker: "", content: words(gone[k], added[k]) });
    for (const text of gone.slice(paired)) out.push({ marker: "", content: <Del>{plain(text)}</Del> });
    for (const text of added.slice(paired)) out.push({ marker: "", content: <Ins>{plain(text)}</Ins> });
  }
  return out;
}

export function riffDiff(before: string, after: string): { blocks: ReactNode[]; changes: number } {
  const ops = script(blocksOf(before), blocksOf(after));
  const blocks: ReactNode[] = [];
  let changes = 0;
  const whole = (block: string, mark?: "del" | "ins") => {
    const { shape, lines } = shapeOf(block);
    blocks.push(<Block key={blocks.length} shape={shape} mark={mark} lines={lines.map((line) => ({ marker: line.marker, content: plain(line.text) }))} />);
  };
  for (let index = 0; index < ops.length;) {
    if (ops[index].type === "same") { whole(ops[index].value); index++; continue; }
    const gone: string[] = [];
    const added: string[] = [];
    while (index < ops.length && ops[index].type !== "same") (ops[index].type === "del" ? gone : added).push(ops[index++].value);
    changes++;
    const paired = Math.min(gone.length, added.length);
    for (let k = 0; k < paired; k++) {
      const a = shapeOf(gone[k]);
      const b = shapeOf(added[k]);
      if (a.shape === b.shape && a.lines.length === b.lines.length && a.shape !== "hr") {
        blocks.push(<Block key={blocks.length} shape={b.shape} lines={b.lines.map((line, at) => ({ marker: line.marker, content: words(a.lines[at].text, line.text) }))} />);
      } else if (a.shape === b.shape && (a.shape === "ul" || a.shape === "ol" || a.shape === "task")) {
        blocks.push(<Block key={blocks.length} shape={b.shape} lines={listLines(a.lines, b.lines)} />);
      } else { whole(gone[k], "del"); whole(added[k], "ins"); }
    }
    for (const block of gone.slice(paired)) whole(block, "del");
    for (const block of added.slice(paired)) whole(block, "ins");
  }
  return { blocks, changes };
}

export function RiffDiff({ before, after }: { before: string; after: string }) {
  const { blocks } = riffDiff(before, after);
  return <div className="prose-note riff-text" data-riff-diff aria-label="Perry's edit, with removed words struck through and added words highlighted">{blocks}</div>;
}
