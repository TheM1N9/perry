import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { PATHS } from "../../runner/home";

/**
 * The script workspace (issue #159). Each short-video script the owner and
 * Perry write together is a folder in Perry's files, by channel:
 *
 *   files/scripts/<channel>/<slug>/
 *     v1.md, v2.md, …  each version as it was saved; a save never changes an earlier one
 *     notes.md         its title, channel and status, then under each version: the hook
 *                      it opens with, what changed, the hooks tried, its sources, the
 *                      claims cut and why, and the owner's feedback on it
 *
 * The folder is all there is. The owner can open, copy or edit it by hand, and
 * Perry's tools and the Work page read it from there each time, so they show
 * what is on disk rather than a copy of it.
 */

export const STATUSES = ["draft", "final", "shot"] as const;
export type ScriptStatus = (typeof STATUSES)[number];
export type Cut = { claim: string; why: string };
/** What goes with one version, each part optional. */
export type VersionNotes = { hook?: string; changed?: string; hooks?: string[]; sources?: string[]; cuts?: Cut[]; feedback?: string[] };

export type ScriptSummary = {
  /** The folder names, which is how a script is found again. */
  channel: string;
  slug: string;
  title: string;
  /** The channel as the owner calls it. */
  channelName: string;
  status: ScriptStatus;
  versions: number;
  /** The latest version's number: v3. */
  latest: number;
  /** The latest version's hook: as noted, or its first line. */
  hook?: string;
  updatedAt: number;
  path: string;
};
export type ScriptVersion = { version: number; text: string; savedAt: number; notes: string };

// Perry's home, not the project: each file call below says so, keeping it out of the server build's file trace.
const ROOT = join(PATHS.files, "scripts");
const VERSION_FILE = /^v(\d+)\.md$/;
const NOTES = "notes.md";
/** What a folder name may be made of: letters (any script, with their marks), digits and hyphens. */
const NAME = /^[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*$/u;
/** Names Windows keeps for devices; a folder called one of them cannot be made. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
/** Headings under each version, in the order a save writes them. */
const PARTS = { hooks: "Hooks tried", sources: "Sources", cuts: "Cut", feedback: "Feedback" } as const;

/** "Amazon's Boomerang: returns" as a folder name: "amazons-boomerang-returns". Telugu or Hindi stays as it is. */
export function folderName(text: string): string {
  const name = text.normalize("NFKC").toLowerCase().replace(/['’`]/g, "").replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return RESERVED.test(name) ? `${name}-script` : name;
}

/**
 * A channel or slug as given, made a folder name. One that reaches for another
 * folder (a slash, "..") is refused rather than quietly renamed.
 */
function nameOf(given: string, what: "channel" | "script"): string {
  if (/[\\/]|\.\./.test(given)) throw new Error(`“${given}” is not a ${what} name: no slashes or dots. list_scripts shows the names in use.`);
  const name = folderName(given);
  if (!NAME.test(name)) throw new Error(`“${given}” is not a ${what} name: use letters, digits and hyphens. list_scripts shows the names in use.`);
  return name;
}

/** A script's folder, always inside the scripts folder. */
function folderOf(channel: string, slug: string): string {
  const dir = resolve(ROOT, channel, slug);
  const inside = relative(ROOT, dir);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("That is not a script's folder.");
  return dir;
}

/** A folder here, not a link to somewhere else. */
const isFolder = (path: string) => { try { return lstatSync(/*turbopackIgnore: true*/ path).isDirectory(); } catch { return false; } };
const folders = (path: string) => isFolder(path) ? readdirSync(/*turbopackIgnore: true*/ path, { withFileTypes: true }).filter((entry) => entry.isDirectory() && NAME.test(entry.name)).map((entry) => entry.name) : [];
const read = (path: string) => { try { return readFileSync(/*turbopackIgnore: true*/ path, "utf8"); } catch { return ""; } };

function versionsIn(dir: string): number[] {
  return readdirSync(/*turbopackIgnore: true*/ dir).map((name) => Number(VERSION_FILE.exec(name)?.[1])).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
}

// --- notes.md ------------------------------------------------------------------------

type Notes = { head: string; sections: Array<{ version: number; body: string }> };

/** notes.md in two parts: the head (title, channel, status), then a section per version. */
function parseNotes(text: string): Notes {
  const parts = text.replace(/\r\n/g, "\n").split(/^(?=## v\d+\b)/m);
  const head = parts[0].startsWith("## v") ? "" : parts.shift()!;
  return { head, sections: parts.map((body) => ({ version: Number(/^## v(\d+)/.exec(body)![1]), body })) };
}

const renderNotes = (notes: Notes) => `${[notes.head.trimEnd(), ...notes.sections.map((section) => section.body.trimEnd())].join("\n\n")}\n`;

const fieldOf = (head: string, name: string) => new RegExp(`^${name}:[ \\t]*(.+)$`, "mi").exec(head)?.[1].trim();

function withField(head: string, name: string, value: string): string {
  const line = new RegExp(`^${name}:.*$`, "mi");
  if (line.test(head)) return head.replace(line, `${name}: ${value}`);
  return `${head.trimEnd()}\n${name}: ${value}\n`;
}

const bullet = (text: string) => `- ${text.trim().replace(/\s*\n\s*/g, " ")}`;

/** Add lines under a version's heading ("### Feedback"), making the heading if it is not there yet. */
function addUnder(body: string, heading: string, lines: string[]): string {
  if (!lines.length) return body;
  const text = body.trimEnd();
  const start = new RegExp(`^### ${heading}[ \\t]*$`, "mi").exec(text);
  if (!start) return `${text}\n\n### ${heading}\n\n${lines.join("\n")}`;
  const after = start.index + start[0].length;
  const next = text.slice(after).search(/^#{2,3} /m);
  const end = next < 0 ? text.length : after + next;
  return `${text.slice(0, end).trimEnd()}\n${lines.join("\n")}${next < 0 ? "" : `\n\n${text.slice(end)}`}`;
}

function addNotes(body: string, notes: VersionNotes): string {
  let next = body;
  next = addUnder(next, PARTS.hooks, (notes.hooks ?? []).map(bullet));
  next = addUnder(next, PARTS.sources, (notes.sources ?? []).map(bullet));
  next = addUnder(next, PARTS.cuts, (notes.cuts ?? []).map((cut) => bullet(`“${cut.claim.trim()}”: ${cut.why.trim()}`)));
  next = addUnder(next, PARTS.feedback, (notes.feedback ?? []).map(bullet));
  return next;
}

// --- Finding, reading and listing ---------------------------------------------------------

type Place = { channel: string; slug: string; dir: string };

/** A script by its slug, and its channel when the same slug is in more than one; null when there is none. */
function locate(slug: string, channel?: string): Place | null {
  const name = nameOf(slug, "script");
  const channels = channel ? [nameOf(channel, "channel")] : folders(ROOT);
  const found = channels.filter((item) => isFolder(folderOf(item, name)));
  if (found.length > 1) throw new Error(`“${name}” is in more than one channel (${found.join(", ")}): pass channel too.`);
  return found.length ? { channel: found[0], slug: name, dir: folderOf(found[0], name) } : null;
}

export function findScript(slug: string, channel?: string): Place {
  const found = locate(slug, channel);
  if (!found) throw new Error(`There is no script “${slug}”${channel ? ` in ${channel}` : ""}. list_scripts shows them.`);
  return found;
}

function summaryOf(channel: string, slug: string): ScriptSummary | null {
  const dir = folderOf(channel, slug);
  const versions = versionsIn(dir);
  const notesText = read(join(dir, NOTES));
  if (!versions.length && !notesText) return null;
  const { head, sections } = parseNotes(notesText);
  const latest = versions.at(-1);
  const status = fieldOf(head, "Status")?.toLowerCase() as ScriptStatus | undefined;
  const noted = sections.find((section) => section.version === latest)?.body.match(/^Hook:[ \t]*(.+)$/m)?.[1].trim();
  const opening = latest ? read(join(dir, `v${latest}.md`)).split("\n").map((line) => line.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) : undefined;
  const times = [latest ? join(dir, `v${latest}.md`) : "", join(dir, NOTES)].filter((path) => path && existsSync(/*turbopackIgnore: true*/ path)).map((path) => statSync(/*turbopackIgnore: true*/ path).mtimeMs);
  return {
    channel, slug,
    title: /^# (.+)$/m.exec(head)?.[1].trim() || slug,
    channelName: fieldOf(head, "Channel") || channel,
    status: status && (STATUSES as readonly string[]).includes(status) ? status : "draft",
    versions: versions.length,
    latest: latest ?? 0,
    ...(noted || opening ? { hook: (noted || opening)!.slice(0, 300) } : {}),
    updatedAt: Math.max(0, ...times),
    path: dir,
  };
}

/** Every script, most recently changed first. */
export function listScripts(): ScriptSummary[] {
  return folders(ROOT)
    .flatMap((channel) => folders(join(ROOT, channel)).map((slug) => summaryOf(channel, slug)))
    .filter((script): script is ScriptSummary => script !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A script with every version and the notes on each. */
export function readScript(slug: string, channel?: string): ScriptSummary & { all: ScriptVersion[]; notes: string } {
  const found = findScript(slug, channel);
  const summary = summaryOf(found.channel, found.slug);
  if (!summary) throw new Error(`The script “${found.slug}” has no versions yet.`);
  const notesText = read(join(found.dir, NOTES));
  const { sections } = parseNotes(notesText);
  const all = versionsIn(found.dir).map((version) => {
    const file = join(found.dir, `v${version}.md`);
    return {
      version,
      text: read(file),
      savedAt: statSync(/*turbopackIgnore: true*/ file).mtimeMs,
      notes: sections.find((section) => section.version === version)?.body.replace(/^## .*\n+/, "").trim() ?? "",
    };
  });
  return { ...summary, all, notes: notesText };
}

// --- Writing ------------------------------------------------------------------------------

function writeNotes(dir: string, change: (notes: Notes) => void) {
  const notes = parseNotes(read(join(dir, NOTES)));
  change(notes);
  writeFileSync(/*turbopackIgnore: true*/ join(dir, NOTES), renderNotes(notes), "utf8");
}

function sectionOf(notes: Notes, version: number) {
  let section = notes.sections.find((item) => item.version === version);
  if (!section) {
    section = { version, body: `## v${version}` };
    notes.sections.push(section);
    notes.sections.sort((a, b) => a.version - b.version);
  }
  return section;
}

/**
 * Save a new version: the next number up, never over an earlier one (made with
 * `wx`, so two saves at once each get their own). A new script needs a title
 * and a channel. The owner's feedback is about the version they saw, so it goes
 * under the one before; the rest goes under the new one. A new version is a
 * draft again unless a status comes with it.
 */
export function saveVersion(input: VersionNotes & {
  text: string; title?: string; channel?: string; slug?: string; status?: ScriptStatus; when: string;
}): { channel: string; slug: string; version: number; versions: number; status: ScriptStatus; path: string; created: boolean; newChannel: boolean } {
  let created = false;
  let newChannel = false;
  // Without a slug, a title already saved in that channel is the same script.
  let place = input.slug ? locate(input.slug, input.channel)
    : input.title?.trim() && input.channel?.trim() ? locate(input.title, input.channel) : null;
  if (!place) {
    if (!input.title?.trim()) throw new Error(input.slug ? `There is no script “${input.slug}” yet; to start one, give title and channel. list_scripts shows the ones there are.` : "A new script needs a title.");
    if (!input.channel?.trim()) throw new Error("A new script needs the channel it is for.");
    const channel = nameOf(input.channel, "channel");
    const slug = nameOf(input.slug ?? input.title, "script");
    newChannel = !isFolder(join(ROOT, channel));
    place = { channel, slug, dir: folderOf(channel, slug) };
    mkdirSync(/*turbopackIgnore: true*/ place.dir, { recursive: true });
    created = true;
  }
  const { dir, channel, slug } = place;

  const before = versionsIn(dir).at(-1) ?? 0;
  let version = before + 1;
  for (;; version++) {
    try {
      writeFileSync(/*turbopackIgnore: true*/ join(dir, `v${version}.md`), `${input.text.trimEnd()}\n`, { encoding: "utf8", flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  const status = input.status ?? "draft";
  writeNotes(dir, (notes) => {
    if (!notes.head.trim()) notes.head = `# ${(input.title ?? slug).trim()}\n\nChannel: ${input.channel?.trim() || channel}\nStatus: ${status}\n`;
    else {
      if (input.title?.trim() && !created) notes.head = notes.head.replace(/^# .*$/m, `# ${input.title.trim()}`);
      notes.head = withField(notes.head, "Status", status);
    }
    const section = sectionOf(notes, version);
    const lines = [`## v${version} · ${input.when}`];
    if (input.hook?.trim()) lines.push(`Hook: ${input.hook.trim().replace(/\s*\n\s*/g, " ")}`);
    if (input.changed?.trim()) lines.push(`What changed: ${input.changed.trim().replace(/\s*\n\s*/g, " ")}`);
    section.body = lines.join("\n\n");
    section.body = addNotes(section.body, { hooks: input.hooks, sources: input.sources, cuts: input.cuts, ...(before ? {} : { feedback: input.feedback }) });
    if (before && input.feedback?.length) {
      const previous = sectionOf(notes, before);
      previous.body = addUnder(previous.body, PARTS.feedback, input.feedback.map(bullet));
    }
  });
  return { channel, slug, version, versions: versionsIn(dir).length, status, path: dir, created, newChannel };
}

/** Notes on a version already saved (the latest unless named), a new status, or a new title. */
export function updateScript(input: VersionNotes & { slug: string; channel?: string; version?: number; status?: ScriptStatus; title?: string }): { channel: string; slug: string; version: number; status: ScriptStatus } {
  const place = findScript(input.slug, input.channel);
  const versions = versionsIn(place.dir);
  const version = input.version ?? versions.at(-1);
  if (!version || !versions.includes(version)) throw new Error(`“${place.slug}” has ${versions.length ? `versions ${versions.join(", ")}` : "no versions"}; there is no v${input.version}.`);
  let status: ScriptStatus = "draft";
  writeNotes(place.dir, (notes) => {
    if (!notes.head.trim()) notes.head = `# ${place.slug}\n\nChannel: ${place.channel}\nStatus: draft\n`;
    if (input.status) notes.head = withField(notes.head, "Status", input.status);
    if (input.title?.trim()) notes.head = notes.head.replace(/^# .*$/m, `# ${input.title.trim()}`);
    const current = fieldOf(notes.head, "Status")?.toLowerCase();
    status = current && (STATUSES as readonly string[]).includes(current) ? current as ScriptStatus : "draft";
    const section = sectionOf(notes, version);
    section.body = addNotes(section.body, input);
  });
  return { channel: place.channel, slug: place.slug, version, status };
}
