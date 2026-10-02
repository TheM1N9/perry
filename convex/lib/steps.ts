/**
 * One step of a turn's trace (runSpans) as the chat shows it opened: the
 * command and how it ended, the files and their diff, the page Perry's browser
 * was on, the search and what it found, or the tool, what it was given and
 * what it said. Pure functions with no server imports.
 *
 * Only what the trace keeps is used: its text is cut to 2 KB and has saved
 * login values hidden (codex.ts, recordTrace), so nothing here can show one.
 */

import { innerCommand } from "./activity";

type Span = { kind: string; name: string; status: string; input?: string; output?: string };
export type Link = { name: string; path: string; url?: string };

export type StepCard =
  | { kind: "command"; command: string; output?: string; exit?: number; cut: boolean }
  | { kind: "file"; files: Link[]; diff?: string; cut: boolean; error?: string }
  | { kind: "browser"; action: string; target?: string; url?: string; title?: string; picture?: string; error?: string }
  | { kind: "search"; query: string; results: Array<{ title?: string; url: string }>; error?: string }
  | { kind: "tool"; name: string; args: Array<{ key: string; value: string }>; result?: string; cut: boolean; error?: boolean };

/** The marks runner/trace.ts leaves where it cut a text short. */
const CUT_END = "... [truncated]";
const CUT_START = "[truncated] ...";

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/**
 * What a tool answered, out of the wrappers the engines put it in: MCP's
 * content parts (Codex keeps them as JSON), and Perry's mark on what came
 * from outside. A text cut short is no longer JSON, so it is unwrapped by
 * hand: the start of a result is what the trace keeps.
 */
export function unwrap(text: string): unknown {
  let value: unknown = text;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof value === "string") {
      const parsed = parse(value);
      if (parsed !== undefined) { value = parsed; continue; }
      return loose(value);
    }
    if (Array.isArray(value) && value.length > 0 && value.every((part) => typeof record(part).type === "string")) {
      value = value.map((part) => record(part).type === "text" ? String(record(part).text ?? "") : `[${String(record(part).type)}]`).join("\n");
      continue;
    }
    const found = record(value);
    if ("untrusted" in found && "result" in found) { value = found.result; continue; }
    break;
  }
  return value;
}

/** A cut result, unwrapped as far as its text goes. */
function loose(text: string): string {
  let out = text;
  const part = /^\[\{"type":"text","text":"/.exec(out);
  if (part) {
    out = out.slice(part[0].length).replace(/"\}\]$/, "");
    out = out.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (_, code: string) =>
      code.startsWith("u") ? String.fromCharCode(parseInt(code.slice(1), 16)) : ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[code] ?? code);
  }
  const outside = /^\{"untrusted":"(?:[^"\\]|\\.)*","result":/.exec(out);
  return outside ? out.slice(outside[0].length) : out;
}

/** A string field of a result, whole or cut short. */
function field(text: string, key: string): string | undefined {
  const found = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text)?.[1];
  if (found === undefined) return undefined;
  const value = parse(`"${found}"`);
  return typeof value === "string" ? value : found;
}

const shown = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
const cut = (text: string | undefined) => Boolean(text && (text.endsWith(CUT_END) || text.startsWith(CUT_START)));
/** The text without the marks, and without the line the cut went through. */
const uncut = (text: string) => {
  let out = text;
  if (out.startsWith(CUT_START)) out = out.slice(CUT_START.length).replace(/^[^\n]*\n/, "");
  if (out.endsWith(CUT_END)) out = out.slice(0, -CUT_END.length).replace(/\n[^\n]*$/, "");
  return out.trim();
};
/** A diff without its header lines: the files are named above it. */
const body = (diff: string) => diff.split("\n").filter((line) => !/^(?:--- |\+\+\+ |diff --git |index [0-9a-f])/.test(line)).join("\n");

/** The id of the picture a browser step took (tools.ts, browser), from the start of its result. */
export function pictureOf(span: Span): string | undefined {
  if (span.kind !== "mcpToolCall" || span.name !== "browser" || !span.output) return undefined;
  return field(shown(unwrap(span.output)), "preview");
}

/** The paths a file step changed. */
export const filesOf = (span: Span) => span.name.split(", ").filter(Boolean);

/** Links found in a search's results: titled ones when the engine gave titles, else every address. */
function results(text: string): Array<{ title?: string; url: string }> {
  const titled = [...text.matchAll(/\{\s*\\?"title\\?"\s*:\s*\\?"((?:[^"\\]|\\.)*?)\\?"\s*,\s*\\?"url\\?"\s*:\s*\\?"((?:[^"\\]|\\.)*?)\\?"/g)]
    .map((match) => ({ title: match[1]!.replace(/\\(.)/g, "$1"), url: match[2]!.replace(/\\(.)/g, "$1") }));
  const found = titled.length ? titled : [...new Set(text.match(/https?:\/\/[^\s"'<>)\]\\,]+/g) ?? [])].map((url) => ({ url }));
  return found.filter((link) => /^https?:\/\//.test(link.url)).filter((link, index, all) => all.findIndex((other) => other.url === link.url) === index).slice(0, 8);
}

/** What a step shows opened, with the links the server resolved: each changed file's, and the browser's picture. */
export function stepCard(span: Span, links: { files?: Map<string, string>; picture?: string } = {}): StepCard {
  const failed = span.status === "error" || span.status === "declined";
  switch (span.kind) {
    case "command": {
      const line = span.input?.startsWith("$ ") ? span.input.slice(2).replace(/\ncwd: [^\n]*$/, "") : span.name;
      let output = span.output;
      const exit = output && /^exit (-?\d+)\n/.exec(output);
      if (exit) output = output!.slice(exit[0].length);
      return { kind: "command", command: innerCommand(uncut(line)), ...(output?.trim() ? { output: uncut(output) } : {}), ...(exit ? { exit: Number(exit[1]) } : {}), cut: cut(span.output) };
    }
    case "fileChange": {
      const files = filesOf(span).map((path) => ({ name: baseName(path), path, ...(links.files?.get(path) ? { url: links.files.get(path)! } : {}) }));
      const diff = span.output && /^(?:[-+@]|--- |diff )/m.test(span.output) ? span.output : undefined;
      return { kind: "file", files, ...(diff ? { diff: body(uncut(diff)) } : {}), cut: cut(diff), ...(failed && !diff && span.output ? { error: span.output } : {}) };
    }
    case "webSearch": {
      const input = record(parse(span.input ?? ""));
      const query = typeof input.query === "string" ? input.query : typeof input.url === "string" ? input.url : span.input || span.name;
      const out = span.output ?? "";
      return { kind: "search", query, results: failed ? [] : results(out.replace(/\\"/g, '"')), ...(failed && out ? { error: out } : {}) };
    }
    case "mcpToolCall":
      if (span.name === "browser") {
        const args = record(parse(span.input ?? ""));
        const result = span.output ? shown(unwrap(span.output)) : "";
        const error = field(result, "error") ?? field(result, "note") ?? (failed && result ? result : undefined);
        const target = typeof args.url === "string" ? args.url : typeof args.text === "string" ? `“${args.text}”` : typeof args.option === "string" ? args.option : undefined;
        return {
          kind: "browser",
          action: typeof args.action === "string" ? args.action : "look",
          ...(target ? { target } : {}),
          ...(field(result, "url") ? { url: field(result, "url") } : {}),
          ...(field(result, "title") ? { title: field(result, "title") } : {}),
          ...(links.picture ? { picture: links.picture } : {}),
          ...(error ? { error } : {}),
        };
      }
    // falls through: any other tool
    default: {
      const input = span.input ? parse(span.input) : undefined;
      const args = input && typeof input === "object" && !Array.isArray(input)
        ? Object.entries(input as Record<string, unknown>).slice(0, 10).map(([key, value]) => ({ key, value: (typeof value === "string" ? value : JSON.stringify(value) ?? "").slice(0, 300) }))
        : span.input ? [{ key: "", value: span.input.slice(0, 600) }] : [];
      const result = span.output ? shown(unwrap(span.output)) : undefined;
      return { kind: "tool", name: span.name, args, ...(result?.trim() ? { result: uncut(result) } : {}), cut: cut(span.output), ...(failed ? { error: true } : {}) };
    }
  }
}
