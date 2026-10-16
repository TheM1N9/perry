type Node = {
  type: string;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

// Only the unfinished tail gets a second parse, never a second whole-message
// parse. Long/ambiguous fragments retain the installed parser's native behavior.
const MAX_TAIL = 4096;
const MAX_COLUMNS = 32;

function cells(line: string): string[] {
  const result: string[] = [];
  let from = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\") { i++; continue; }
    if (line[i] === "|") { result.push(line.slice(from, i)); from = i + 1; }
  }
  result.push(line.slice(from));
  if (!result[0].trim()) result.shift();
  if (result.length && !result.at(-1)!.trim()) result.pop();
  return result;
}

/** A leading pipe is a provisional table; otherwise wait for a delimiter row. */
function tableTail(source: string): string | undefined {
  const lines = source.trimEnd().split(/\r?\n/);
  if (lines.length > 2) return;
  const [header, delimiter] = lines;
  if (!header.includes("|")) return;
  if (!/^ {0,3}\|/.test(header) && !(delimiter && /^[ |:\t-]+$/.test(delimiter) && delimiter.includes("-"))) return;
  if (delimiter !== undefined && !/^[ |:\t-]*$/.test(delimiter)) return;
  const columns = cells(header);
  if (!columns.length) return ""; // The very first pipe has no visible content yet.
  if (columns.length > MAX_COLUMNS) return;
  const partial = delimiter === undefined ? [] : cells(delimiter);
  return `${header}\n| ${columns.map((_, i) => {
    const cell = partial[i]?.trim() ?? "";
    return `${cell.startsWith(":") ? ":" : ""}---${cell.endsWith(":") && cell.length > 1 ? ":" : ""}`;
  }).join(" | ")} |`;
}

/**
 * Look only at unresolved text tokens. The native parser has already identified
 * complete code, links, HTML and emphasis; their contents must not be guessed at.
 * This is deliberately conservative rather than a second Markdown tokenizer.
 */
function inlineTail(source: string, node: Node, start: number): string | undefined {
  const closing: string[] = [];
  for (const child of node.children ?? []) {
    if (child.type !== "text") continue;
    const from = child.position?.start.offset;
    const to = child.position?.end.offset;
    if (from === undefined || to === undefined) continue;
    const raw = source.slice(from - start, to - start);
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "\\") { i++; continue; }
      const marker = raw[i];
      if (!"*_~`".includes(marker)) continue;
      let end = i + 1;
      while (raw[end] === marker) end++;
      const token = raw.slice(i, end);
      const before = source[from - start + i - 1] ?? "";
      const after = source[from - start + end] ?? "";
      i = end - 1;
      if (marker === "~" && token.length !== 2) continue;
      if (marker !== "`" && token.length > 3) continue;
      // Do not turn snake_case, multiplication or whitespace into emphasis.
      if (marker !== "`" && ((before && /[\p{L}\p{N}]/u.test(before)) || /\s/.test(after))) continue;
      if (!after) {
        // Hide a delimiter which arrived before its content, including the
        // first one/two characters of a fence, until its intent becomes clear.
        if (!before || /\s/.test(before)) return source.slice(0, from - start + end - token.length).trimEnd() + closing.reverse().join("");
        continue;
      }
      if (marker === "`") return source + token + closing.reverse().join(""); // Everything after it is code.
      closing.push(token);
      if (closing.length > 32) return;
    }
  }
  if (!closing.length) return;
  return source.trimEnd() + closing.reverse().join("") + source.slice(source.trimEnd().length);
}

/**
 * Streaming-only remark transform using the already configured GFM parser.
 * CommonMark accepts unclosed fences at EOF, so leave all code blocks alone.
 * No timers, cached message text, new dependencies or altered URL/HTML policy.
 */
export function streamingMarkdown(this: { parse: (source: string) => Node }, { streaming = false }: { streaming?: boolean } = {}) {
  const parser = this;
  return (tree: Node, file: { value: unknown }) => {
    if (!streaming) return;
    let parent = tree;
    let tail = parent.children?.at(-1);
    // Descend only the live edge, keeping old blocks and literal code untouched.
    while (tail && ["blockquote", "list", "listItem", "table", "tableRow"].includes(tail.type)) {
      parent = tail;
      tail = tail.children?.at(-1);
    }
    if (!tail || !["paragraph", "heading", "tableCell"].includes(tail.type)) return;
    const start = tail.position?.start.offset;
    const end = tail.position?.end.offset;
    if (start === undefined || end === undefined || end - start > MAX_TAIL) return;
    const text = String(file.value);
    if (!/^[\t ]*(?:\r?\n)?[\t ]*$/.test(text.slice(end))) return;
    const source = text.slice(start, end);
    const table = parent === tree && tail.type === "paragraph" ? tableTail(source) : undefined;
    const repaired = table ?? inlineTail(source, tail, start);
    if (repaired === undefined || repaired === source) return;
    const parsed = parser.parse(repaired);
    if (table !== undefined) {
      // Replacement is still passed through remark-rehype and react-markdown's
      // default sanitization and Perry's normal table components.
      if (parsed.children?.every((node) => node.type === "table")) parent.children!.splice(parent.children!.length - 1, 1, ...parsed.children);
    } else if (parsed.children?.length === 1 && parsed.children[0].type === tail.type) {
      tail.children = parsed.children[0].children;
    } else if (tail.type === "tableCell" && parsed.children?.[0]?.type === "paragraph") {
      tail.children = parsed.children[0].children;
    } else if (!repaired) {
      tail.children = [];
    }
  };
}
