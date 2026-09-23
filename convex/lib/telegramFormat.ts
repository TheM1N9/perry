/**
 * Markdown, as Codex writes it, into the HTML subset Telegram renders.
 *
 * Only what Telegram can show is converted: bold, italic, strikethrough, inline
 * code, code blocks with their language, and links. Headings become bold.
 * Lists, quotes and tables stay as the text they already read well as.
 * Everything is escaped first, so a stray `<` or `&` in a reply is shown, not
 * parsed.
 */

type Segment = { readonly kind: "text" | "code"; readonly text: string };

// Adapted from vercel/eve (Apache-2.0): packages/eve/src/public/channels/slack/mrkdwn.ts
/** Code is shown as written, so find it first and keep the other rules away from it. */
function splitCodeFences(input: string): Segment[] {
  const segments: Segment[] = [];
  const fenceRe = /```[\s\S]*?```|`[^`\n]+`/gu;
  let lastIndex = 0;
  for (const match of input.matchAll(fenceRe)) {
    const start = match.index ?? 0;
    if (start > lastIndex) segments.push({ kind: "text", text: input.slice(lastIndex, start) });
    segments.push({ kind: "code", text: match[0] });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < input.length) segments.push({ kind: "text", text: input.slice(lastIndex) });
  return segments;
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function codeToHtml(code: string): string {
  if (!code.startsWith("```")) return `<code>${escape(code.slice(1, -1))}</code>`;
  const body = code.slice(3, -3);
  const newline = body.indexOf("\n");
  const first = newline === -1 ? "" : body.slice(0, newline).trim();
  // The opening line names the language only when it is one word.
  const language = /^[\w#+.-]+$/.test(first) ? first : "";
  const content = (newline === -1 || (first && !language) ? body : body.slice(newline + 1)).replace(/\n$/, "");
  return language
    ? `<pre><code class="language-${language}">${escape(content)}</code></pre>`
    : `<pre>${escape(content)}</pre>`;
}

/** Emphasis on text that is already escaped. Markers must hug their words, so `2 * 3 * 4` and snake_case stay as they are. */
function emphasis(html: string): string {
  return html
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "<b>$1</b>")
    .replace(/(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)/g, "<b>$1</b>")
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "<s>$1</s>")
    .replace(/(?<![\w*])\*(?=[^\s*])([^*\n]+?)(?<=\S)\*(?![\w*])/g, "<i>$1</i>")
    .replace(/(?<![\w_])_(?=[^\s_])([^_\n]+?)(?<=\S)_(?![\w_])/g, "<i>$1</i>");
}

function textToHtml(text: string): string {
  // Links are set aside first, so emphasis never reaches into a URL.
  const kept: string[] = [];
  const keep = (html: string) => `${kept.push(html) - 1}`;
  const set = text
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) =>
      keep(`<a href="${escape(url).replace(/"/g, "&quot;")}">${emphasis(escape(label))}</a>`))
    .replace(/https?:\/\/[^\s<>()]+/g, (url) => keep(escape(url)));
  const html = emphasis(escape(set)
    .replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, (_match, title: string) => `<b>${title.replace(/\*\*|__/g, "")}</b>`));
  return html.replace(/(\d+)/g, (_match, index: string) => kept[Number(index)]);
}

/** Telegram HTML for one message's worth of Markdown. */
export function toTelegramHtml(markdown: string): string {
  return splitCodeFences(markdown)
    .map((segment) => (segment.kind === "code" ? codeToHtml(segment.text) : textToHtml(segment.text)))
    .join("");
}

/**
 * A long reply is split before it is formatted, so no tag straddles two
 * messages. A code block cut in two is closed at the end of one piece and
 * reopened, with its language, at the start of the next.
 */
export function balanceFences(chunks: string[]): string[] {
  let open: string | null = null;
  return chunks.map((chunk) => {
    const text = open === null ? chunk : `\`\`\`${open}\n${chunk}`;
    let state: string | null = null;
    for (const match of text.matchAll(/^[ \t]*```([^\s`]*)/gm)) state = state === null ? match[1] : null;
    open = state;
    return state === null ? text : `${text}\n\`\`\``;
  });
}
