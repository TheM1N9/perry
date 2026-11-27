import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { defuse, type EngineAttachment } from "./engine";
import { onPath } from "./versions";

/**
 * Files someone sent, made into what every engine reads with no tools at all:
 * a PDF's pages as pictures and its text, plain text and an Office file's text (and its pages,
 * when LibreOffice is here to draw them). A chat with someone else has no shell
 * or files (engine.ts, TurnInput.guest), so a path to their PDF told the engine
 * nothing it could open; the owner's own turns get the same, beside the file.
 *
 * What is made goes in `dir`, the folder the turn may read: the guest folder for
 * someone else's chat. Nothing here runs for the engine or on its behalf; the
 * runner reads the file, as it always has to hand it over.
 */

export type ReadableOptions = {
  /** Pages drawn as pictures, for all of a message's files together. */
  maxPages?: number;
  /** The longest side of a page's picture, in pixels. */
  maxSide?: number;
  /** Text kept of each file. */
  maxChars?: number;
  /**
   * Someone else's turn (engine.ts, TurnInput.guest): their file names are defused like their words, and
   * what was made of a file goes in its place, since the path to the original is one the turn cannot open.
   * The owner's turn keeps the file too, beside what was made of it.
   */
  guest?: boolean;
  /** Where LibreOffice is; null for none. Unset looks for it. */
  soffice?: string | null;
};

export type Readable = { attachments: EngineAttachment[]; text: string };

const MAX_PAGES = 20;
const MAX_SIDE = 1600;
const MAX_CHARS = 60_000;
/** Automatic document extraction is bounded independently of the 128 MB transfer limit. */
const MAX_BYTES = 64 * 1024 * 1024;
/** What an Office file may unpack to, so a zip bomb stops early. */
const MAX_UNPACKED = 64 * 1024 * 1024;
const CONVERT_MS = 90_000;
/** What was made for a turn is kept this long, then cleared the next time something is made. */
const KEEP_MS = 7 * 24 * 60 * 60_000;

const OFFICE = new Set([".docx", ".pptx", ".xlsx"]);
/** What LibreOffice can draw as pages besides those. */
const OTHER_OFFICE = new Set([".doc", ".ppt", ".xls", ".odt", ".odp", ".ods", ".rtf"]);
const PDF_TYPES = new Set(["application/pdf", "application/x-pdf"]);
const TEXT_TYPES = /^(?:text\/|application\/(?:[\w.+-]+\+)?(?:json|xml|yaml|toml|javascript|x-yaml|x-javascript)$)/i;
const TEXT_NAMES = new Set([".txt", ".text", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".log", ".html", ".htm", ".svg", ".css", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".sh", ".ps1", ".sql", ".tex", ".eml", ".ics", ".vtt", ".srt"]);
const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const kindOf = (file: EngineAttachment): "pdf" | "office" | "other-office" | "text" | null => {
  const extension = extname(file.localPath ?? file.fileName).toLowerCase();
  const named = extname(file.fileName).toLowerCase();
  const contentType = (file.contentType ?? "").split(";", 1)[0].trim().toLowerCase();
  if (PDF_TYPES.has(contentType) || extension === ".pdf" || named === ".pdf") return "pdf";
  if (OFFICE.has(extension) || OFFICE.has(named)) return "office";
  if (OTHER_OFFICE.has(extension) || OTHER_OFFICE.has(named)) return "other-office";
  if (TEXT_TYPES.test(contentType) || TEXT_NAMES.has(extension) || TEXT_NAMES.has(named)) return "text";
  return null;
};

/**
 * The attachments a turn's engine gets, with text, PDF and Office files made
 * readable, and the text to send after the message. A file that cannot be read
 * (too big, broken, a kind this does not know) goes on with an explicit unread note.
 */
export async function readable(files: EngineAttachment[], dir: string, options: ReadableOptions = {}): Promise<Readable> {
  const named = (file: EngineAttachment) => options.guest ? { ...file, fileName: defuse(file.fileName) } : file;
  const wanted = files.filter((file) => file.localPath && kindOf(file));
  const root = join(dir, "readable");
  if (wanted.length) { await mkdir(root, { recursive: true }); await prune(root); }
  let pages = options.maxPages ?? MAX_PAGES;
  const attachments: EngineAttachment[] = [];
  const texts: string[] = [];
  for (const file of files) {
    if (!wanted.includes(file)) {
      attachments.push(named(file));
      if (!INLINE_IMAGES.has(file.contentType ?? "")) texts.push(`# Attachment ${file.fileName}\n\nAutomatic extraction is not available for this format. The original attachment is still available; inspect it with a suitable tool if needed, and do not claim its contents were read until they were.`);
      continue;
    }
    const out = join(root, randomUUID());
    let failure = "Automatic extraction produced no readable content.";
    const made = await openFile(file, out, { ...options, maxPages: pages }).catch((error: unknown) => {
      console.error(`  Could not read ${file.fileName}: ${error instanceof Error ? error.message : String(error)}`);
      failure = error instanceof Error && error.name === "PasswordException" ? "This document is password protected. Its contents were not read."
        : error instanceof Error && error.message === "Document exceeds the automatic extraction limit." ? "This document exceeds the 64 MB automatic extraction limit. Its contents were not read."
          : "Its contents could not be extracted; it may be damaged, encrypted or use an unsupported encoding.";
      return null;
    });
    if (!made) {
      await rm(out, { recursive: true, force: true }).catch(() => {});
      attachments.push(named(file));
      texts.push(`# Attachment ${file.fileName}\n\nAutomatic extraction failed. ${failure} The original attachment is still available. Use a suitable reader if available; do not claim to have read it from its name or caption.`);
      continue;
    }
    if (!options.guest) attachments.push(file);
    attachments.push(...made.pages.map(named));
    pages -= made.pages.length;
    texts.push(made.text);
  }
  // Words from inside a file are read, never followed: "$name" and "@path" name nothing (engine.ts, defuse).
  return { attachments, text: texts.length ? defuse(texts.join("\n\n")) : "" };
}

type Made = { pages: EngineAttachment[]; text: string };

async function openFile(file: EngineAttachment, out: string, options: ReadableOptions): Promise<Made | null> {
  const path = file.localPath!;
  const size = (await stat(path)).size;
  if (size > MAX_BYTES) throw new Error("Document exceeds the automatic extraction limit.");
  const kind = kindOf(file)!;
  const maxPages = Math.max(0, options.maxPages ?? MAX_PAGES);
  const maxChars = options.maxChars ?? MAX_CHARS;
  if (kind === "text") {
    const handle = await open(path, "r");
    try {
      const bytes = Buffer.alloc(Math.min(size, maxChars * 4 + 4));
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const chunk = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      const content = bytes.subarray(0, bytesRead);
      const encoding = content[0] === 255 && content[1] === 254 ? "utf-16le" : content[0] === 254 && content[1] === 255 ? "utf-16be" : "utf-8";
      if (encoding === "utf-8" && content.includes(0)) throw new Error("Attachment contains binary data.");
      const text = new TextDecoder(encoding, { fatal: true }).decode(content, { stream: bytesRead < size });
      return { pages: [], text: describe(file.fileName, undefined, 0, text, maxChars) };
    } finally { await handle.close(); }
  }
  if (kind === "pdf") {
    const pdf = await pdfOf(await readFile(path), out, file.fileName, maxPages, options.maxSide ?? MAX_SIDE, maxChars);
    return { pages: pdf.pages, text: describe(file.fileName, pdf.count, pdf.pages.length, pdf.text, maxChars) };
  }
  // An Office file's text from its own XML; its pages, when LibreOffice can draw them.
  const words = kind === "office" ? officeText(await readFile(path), extname(file.localPath ?? "") || extname(file.fileName)) : "";
  const soffice = options.soffice === undefined ? findSoffice() : options.soffice;
  const converted = soffice && maxPages > 0 ? await toPdf(soffice, path, out).catch((error: unknown) => {
    console.error(`  LibreOffice could not draw ${file.fileName}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }) : null;
  const pdf = converted ? await pdfOf(await readFile(converted), out, file.fileName, maxPages, options.maxSide ?? MAX_SIDE, maxChars).catch(() => null) : null;
  const text = words || pdf?.text || "";
  if (!text && !pdf?.pages.length) return null;
  return { pages: pdf?.pages ?? [], text: describe(file.fileName, pdf?.count, pdf?.pages.length ?? 0, text, maxChars) };
}

/** What the engine is told of a file, after the message. */
function describe(name: string, count: number | undefined, drawn: number, text: string, maxChars: number): string {
  const cut = text.length > maxChars;
  const body = cut ? `${text.slice(0, maxChars)}\n[… the rest of its text is left out]` : text;
  const pages = count === undefined ? ""
    : drawn === 0 ? ` It has ${count} page${count === 1 ? "" : "s"}; none are attached as pictures.`
      : drawn < count ? ` It has ${count} pages; the first ${drawn} are attached as pictures, in order, after this message.`
        : count === 1 ? " Its page is attached as a picture, after this message." : ` Its ${count} pages are attached as pictures, in order, after this message.`;
  return `# Inside ${name}\n\nThe file that came with this message, opened for you.${pages}\n\n${body.trim() ? `Its text:\n\n${body.trim()}` : count === undefined ? "It contains no readable text." : drawn > 0 ? "It has no text of its own (a scan, say): read the pictures." : "No readable text or page images were included. Use the original document with a suitable reader before describing its contents."}`;
}

// --- PDF ------------------------------------------------------------------------------------------

type Pdf = { count: number; pages: EngineAttachment[]; text: string };

const pdfjsDir = () => dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

async function pdfOf(bytes: Uint8Array, out: string, name: string, maxPages: number, maxSide: number, maxChars: number): Promise<Pdf> {
  const [{ getDocument }, { createCanvas }] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("@napi-rs/canvas")]);
  // What pdf.js reads from its own package on Node: the 14 standard fonts, CJK maps, colour profiles, and the
  // WebAssembly decoders for scans (JPEG 2000, JBIG2). Without the last, a scanned page draws blank.
  const own = (folder: string) => join(pdfjsDir(), folder) + "/";
  // pdf.js 6 builds nothing from a PDF as code (no eval, no scripts), so a stranger's file is only drawn.
  const task = getDocument({
    data: new Uint8Array(bytes), standardFontDataUrl: own("standard_fonts"), cMapUrl: own("cmaps"), cMapPacked: true,
    iccUrl: own("iccs"), wasmUrl: own("wasm"), verbosity: 0,
  });
  const timer = setTimeout(() => void task.destroy(), CONVERT_MS);
  try {
    const doc = await task.promise;
    const pages: EngineAttachment[] = [];
    const text: string[] = [];
    const stem = basename(name, extname(name)) || "page";
    let chars = 0;
    for (let number = 1; number <= doc.numPages; number++) {
      const drawing = number <= maxPages;
      // Text of the pages past the pictures, while it is short enough to keep.
      if (!drawing && chars > maxChars) break;
      const page = await doc.getPage(number);
      const words = (await page.getTextContent()).items.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : "")).join("").trim();
      if (words) { text.push(`## Page ${number}\n\n${words}`); chars += words.length; }
      if (drawing) {
        const first = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: maxSide / Math.max(first.width, first.height) });
        const canvas = createCanvas(Math.max(1, Math.round(viewport.width)), Math.max(1, Math.round(viewport.height)));
        await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport, background: "#ffffff" }).promise;
        const localPath = join(out, `page-${String(number).padStart(3, "0")}.png`);
        if (!pages.length) await mkdir(out, { recursive: true });
        await writeFile(localPath, await canvas.encode("png"));
        pages.push({ localPath, fileName: `${stem}, page ${number}.png`, contentType: "image/png" });
      }
      page.cleanup();
    }
    return { count: doc.numPages, pages, text: text.join("\n\n") };
  } finally {
    clearTimeout(timer);
    await task.destroy();
  }
}

// --- Office ---------------------------------------------------------------------------------------

/** The files in a zip (an Office file is one), by name; deflated or stored, as Office writes them. */
function unzip(bytes: Buffer): Map<string, () => Buffer> {
  const files = new Map<string, () => Buffer>();
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error("not a zip file");
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  let unpacked = 0;
  for (let index = 0; index < count && at + 46 <= bytes.length; index++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) break;
    const method = bytes.readUInt16LE(at + 10);
    const packed = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const skip = nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + skip;
    files.set(name, () => {
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const data = bytes.subarray(start, start + packed);
      const left = MAX_UNPACKED - unpacked;
      if (left <= 0) throw new Error("unpacks to too much");
      const file = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: left }) : Buffer.alloc(0);
      unpacked += file.length;
      return file;
    });
  }
  return files;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };
const unescape = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code: string) =>
  code[0] === "#" ? String.fromCodePoint(Number.parseInt(code.slice(code[1] === "x" || code[1] === "X" ? 2 : 1), code[1] === "x" || code[1] === "X" ? 16 : 10)) : ENTITIES[code] ?? whole);

/** The words of a Word or PowerPoint XML part: its runs of text, a line for each paragraph. */
function paragraphs(xml: string, prefix: "w" | "a"): string {
  const pattern = new RegExp(`<${prefix}:t(?:\\s[^>]*)?>([^<]*)</${prefix}:t>|</${prefix}:p>|<${prefix}:(?:tab|br)\\s*/>`, "g");
  let text = "";
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) text += unescape(match[1]);
    else if (match[0].includes("tab")) text += "\t";
    else text += "\n";
  }
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

const numbered = (names: string[], pattern: RegExp) => names
  .filter((name) => pattern.test(name))
  .sort((a, b) => Number(a.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(b.match(/(\d+)\.xml$/)?.[1] ?? 0));

export function officeText(bytes: Buffer, extension: string): string {
  const zip = unzip(bytes);
  const read = (name: string) => zip.get(name)?.().toString("utf8") ?? "";
  const names = [...zip.keys()];
  switch (extension.toLowerCase()) {
    case ".docx":
      return paragraphs(read("word/document.xml"), "w");
    case ".pptx":
      return numbered(names, /^ppt\/slides\/slide\d+\.xml$/)
        .map((name, index) => `## Slide ${index + 1}\n\n${paragraphs(read(name), "a")}`).join("\n\n");
    case ".xlsx":
      return sheets(read, names);
    default:
      return "";
  }
}

const xmlAttribute = (attributes: string, name: string): string | undefined => {
  for (const attribute of attributes.matchAll(/(?:^|\s)([^\s=<>/"']+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
    if (attribute[1] === name) return unescape(attribute[3]);
  }
  return undefined;
};

/** Each sheet as addressed cells, so omitted empty rows and columns cannot shift values. */
function sheets(read: (name: string) => string, names: string[]): string {
  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((item) => [...item[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((part) => unescape(part[1])).join(""));
  const targets = new Map([...read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map((rel) => [
    xmlAttribute(rel[0], "Id") ?? "", `xl/${(xmlAttribute(rel[0], "Target") ?? "").replace(/^\/?xl\//, "")}`,
  ]));
  const listed = [...read("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)].map((sheet) => ({
    name: xmlAttribute(sheet[0], "name") ?? "",
    path: targets.get(xmlAttribute(sheet[0], "r:id") ?? "") ?? "",
  })).filter((sheet) => names.includes(sheet.path));
  const order = listed.length ? listed : numbered(names, /^xl\/worksheets\/sheet\d+\.xml$/).map((path, index) => ({ name: `Sheet ${index + 1}`, path }));
  return order.map((sheet) => {
    let rowNumber = 0;
    const rows = [...read(sheet.path).matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)].map((row) => {
      const cells = row[2] ?? "";
      const parts = [...cells.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)];
      const declaredRow = xmlAttribute(row[1], "r")?.trim();
      if (declaredRow !== undefined && !/^\+?[0-9]+$/.test(declaredRow)) throw new Error("Invalid spreadsheet row coordinate.");
      const firstCellRow = parts.map(cell => xmlAttribute(cell[1], "r")).find(value => value !== undefined)?.match(/^[A-Z]{1,3}([1-9]\d{0,6})$/i)?.[1];
      rowNumber = declaredRow !== undefined ? Number(declaredRow) : firstCellRow !== undefined ? Number(firstCellRow) : rowNumber + 1;
      if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 1_048_576) throw new Error("Invalid spreadsheet row coordinate.");
      let column = 0;
      return parts.map((cell) => {
        const declaredCell = xmlAttribute(cell[1], "r");
        const coordinate = declaredCell?.match(/^([A-Z]{1,3})([1-9]\d{0,6})$/i);
        if (declaredCell !== undefined && !coordinate) throw new Error("Invalid spreadsheet cell coordinate.");
        column = coordinate ? [...coordinate[1].toUpperCase()].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) : column + 1;
        if (column > 16_384 || coordinate && (Number(coordinate[2]) !== rowNumber)) throw new Error("Invalid spreadsheet cell coordinate.");
        let letters = "";
        for (let number = column; number > 0; number = Math.floor((number - 1) / 26)) letters = String.fromCharCode(65 + (number - 1) % 26) + letters;
        const type = xmlAttribute(cell[1], "t");
        const inner = cell[2] ?? "";
        const raw = unescape(inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? "");
        const value = type === "inlineStr" ? [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((part) => unescape(part[1])).join("")
          : type === "s" ? shared[Number(raw)] ?? "" : raw;
        return `${letters}${rowNumber}: ${value}`;
      }).join("\t");
    }).filter(Boolean);
    return `## ${sheet.name}\n\n${rows.join("\n")}`;
  }).join("\n\n");
}

// --- LibreOffice ----------------------------------------------------------------------------------

/** LibreOffice, where it usually is: on PATH, or where its installer puts it. */
export function findSoffice(): string | null {
  const places = process.platform === "win32"
    ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "LibreOffice", "program", "soffice.exe"), join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "LibreOffice", "program", "soffice.exe")]
    : process.platform === "darwin" ? ["/Applications/LibreOffice.app/Contents/MacOS/soffice"] : [];
  return onPath("soffice") ?? onPath("libreoffice") ?? places.map((place) => onPath(place)).find(Boolean) ?? null;
}

/** The file as a PDF, drawn by LibreOffice with a profile of its own, so one the owner has open is left alone. */
async function toPdf(soffice: string, path: string, out: string): Promise<string> {
  const profile = mkdtempSync(join(tmpdir(), "perry-soffice-"));
  await mkdir(out, { recursive: true });
  try {
    await new Promise<void>((done, fail) => execFile(soffice, [
      `-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--norestore", "--nolockcheck", "--convert-to", "pdf", "--outdir", out, path,
    ], { timeout: CONVERT_MS, windowsHide: true }, (error) => error ? fail(error) : done()));
    const made = (await readdir(out)).find((name) => name.toLowerCase().endsWith(".pdf"));
    if (!made) throw new Error("it made no PDF");
    return join(out, made);
  } finally {
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

/** What was made for turns more than a week ago: their engines have long read it. */
async function prune(root: string) {
  const now = Date.now();
  for (const name of await readdir(root).catch(() => [])) {
    const path = join(root, name);
    const made = await stat(path).then((info) => info.mtimeMs, () => now);
    if (now - made > KEEP_MS) await rm(path, { recursive: true, force: true }).catch(() => {});
  }
}
