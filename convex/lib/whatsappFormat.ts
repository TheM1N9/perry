import { tablesToBlocks } from "./telegramFormat";

/**
 * Markdown, as Codex writes it, into WhatsApp's own formatting: *bold*,
 * _italic_, ~strike~, `code` and ```blocks```. Headings become bold lines,
 * list markers bullets, links "label (url)", and tables a lined-up block
 * (WhatsApp shows none of them). Code is left exactly as written.
 */

// WhatsApp caps a message at 65,536 characters; long ones read better in pieces.
export const WHATSAPP_MESSAGE_LIMIT = 4000;

type Segment = { kind: "text" | "code"; text: string };

function segments(input: string): Segment[] {
  const found: Segment[] = [];
  let last = 0;
  for (const match of input.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)) {
    const start = match.index ?? 0;
    if (start > last) found.push({ kind: "text", text: input.slice(last, start) });
    found.push({ kind: "code", text: match[0] });
    last = start + match[0].length;
  }
  if (last < input.length) found.push({ kind: "text", text: input.slice(last) });
  return found;
}

/** A fenced block keeps its code and loses its language, which WhatsApp would show as text. */
function code(block: string): string {
  if (!block.startsWith("```")) return block;
  const body = block.slice(3, -3);
  const newline = body.indexOf("\n");
  const first = newline === -1 ? "" : body.slice(0, newline).trim();
  const content = newline !== -1 && /^[\w#+.-]+$/.test(first) ? body.slice(newline + 1) : body;
  return "```" + content.replace(/^\n/, "").replace(/\n$/, "") + "```";
}

function text(input: string): string {
  // Bold is set aside first, so the italic rule does not take its stars.
  const bold: string[] = [];
  const keep = (value: string) => `\u{E000}${bold.push(value) - 1}\u{E001}`;
  return input
    .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, (_match, title: string) => keep(`*${title.replace(/\*\*|__/g, "")}*`))
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => label === url ? url : `${label} (${url})`)
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, (_match, inner: string) => keep(`*${inner}*`))
    .replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, (_match, inner: string) => keep(`*${inner}*`))
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "~$1~")
    .replace(/(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=\S)\*(?![\w*])/g, "_$1_")
    .replace(/^([ \t]*)[-*+][ \t]+(?=\S)/gm, "$1• ")
    .replace(/\u{E000}(\d+)\u{E001}/gu, (_match, index: string) => bold[Number(index)]);
}

export function toWhatsApp(markdown: string): string {
  return segments(tablesToBlocks(markdown)).map((part) => (part.kind === "code" ? code(part.text) : text(part.text))).join("").trim();
}

/** Split on paragraphs, then lines, then hard, never inside a code block when it can be helped. */
export function chunkWhatsApp(message: string, limit = WHATSAPP_MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = message.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    const at = cut > limit / 2 ? cut : limit;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
