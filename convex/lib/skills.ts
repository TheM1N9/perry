import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HOME, PATHS } from "../../runner/home";
import { skillMentions } from "./commands";

/**
 * Importing a skill (issue #110) from a URL or a folder, safely. Agent Skills
 * (a folder with a SKILL.md) are shared across Codex, Claude and others, and
 * public collections carry malicious ones (OpenClaw's ClawHub had 341+). So a
 * skill is first fetched to a review folder Codex does not load skills from,
 * read, and summarised for the owner: the commands it runs, the sites it
 * reaches, the files it touches, and anything that looks like a trap. Only
 * on the owner's yes does it move into the skills folder (tools.ts:
 * review_skill, install_skill).
 */

/** Where skills wait for the owner's yes: in Perry's home, outside the skills folder Codex reads. */
const REVIEW = join(HOME, "skills-review");
/** A skill name as Codex takes it. */
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FILES = 60;
const MAX_BYTES = 2 * 1024 * 1024;
/** What of each file the review shows the agent. */
const SHOWN_SKILL = 20_000;
const SHOWN_OTHER = 4_000;
const SKIP = new Set([".git", "node_modules", "__pycache__", ".DS_Store"]);
const TEXT = /\.(md|txt|json|ya?ml|toml|sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|lua|html?|css|csv|xml|ini|cfg|conf|env)$|^[^.]+$/i;
const SCRIPT = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|lua|exe|dll|so|dylib|bin|jar|app|msi|scr|vbs)$/i;
const SHELL_BLOCK = /```(?:sh|bash|zsh|shell|console|powershell|ps1|pwsh|cmd|bat)?\s*\n([\s\S]*?)```/gi;

/** Things a skill has no business saying or doing without the owner knowing. */
const WARNINGS: Array<[RegExp, string]> = [
  [/ignore (all |any )?(previous|prior|earlier|other) (instructions|rules)|disregard (your|the) (instructions|rules)/i, "tells the agent to ignore its instructions"],
  [/(don'?t|do not|never) (tell|inform|mention|show|ask)( it to| this to)? (the )?(user|owner)|without (asking|telling) (the )?(user|owner)|silently/i, "tells the agent to act without the owner knowing"],
  [/(curl|wget|iwr|invoke-webrequest|irm)\b[^\n|]*\|\s*(sh|bash|zsh|iex|invoke-expression|python)/i, "downloads and runs code in one step"],
  [/base64\s+(-d|--decode)|frombase64string|atob\(/i, "decodes hidden (base64) content"],
  [/rm\s+-rf?\s+[~/]|remove-item\b[^\n]*-recurse|del\s+\/[sq]|format\s+[a-z]:/i, "deletes files broadly"],
  [/\.ssh|id_rsa|\.aws\/credentials|\.env\b|keychain|credential manager|cookies?\.sqlite|login data/i, "reaches for keys, passwords or browser data"],
  [/\b(api[_ -]?key|secret|password|token)s?\b[^\n]{0,40}\b(send|post|upload|curl|fetch|webhook)/i, "sends keys or passwords somewhere"],
  [/crontab|launchctl|schtasks|register-scheduledtask|startup folder|\\run\b|systemctl (enable|--user)/i, "makes itself start on its own"],
  [/sudo\b|runas\b|set-executionpolicy|chmod\s+[0-7]*7[0-7]*\s/i, "asks for more rights"],
];

export type Found = { commands: string[]; sites: string[]; paths: string[]; scripts: string[]; warnings: string[] };
export type Staged = { reviewId: string; name: string; description: string; source: string; files: Array<{ path: string; bytes: number }>; skill: string; others: Array<{ path: string; text: string }>; found: Found };

type Loaded = { path: string; bytes: Buffer };

/** The frontmatter's name and description, as Codex reads them. */
function frontmatter(skill: string): { name?: string; description?: string } {
  const block = skill.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!block) return {};
  const field = (key: string) => block[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1].trim().replace(/^["']|["']$/g, "");
  return { name: field("name"), description: field("description") };
}

function readFolder(root: string): Loaded[] {
  const files: Loaded[] = [];
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.isFile()) continue;
      const size = statSync(path).size;
      if (files.length >= MAX_FILES || total + size > MAX_BYTES) throw new Error(`That skill is too big to review (over ${MAX_FILES} files or ${MAX_BYTES / 1024 / 1024} MB).`);
      total += size;
      files.push({ path: relative(root, path).split(sep).join("/"), bytes: readFileSync(path) });
    }
  };
  walk(root);
  return files;
}

/** A GitHub folder, through its contents API: every file under it. */
async function readGitHub(owner: string, repo: string, ref: string, folder: string): Promise<Loaded[]> {
  const files: Loaded[] = [];
  let total = 0;
  const headers = { accept: "application/vnd.github+json", "user-agent": "perry-skill-import" };
  const walk = async (path: string) => {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, { headers });
    if (!response.ok) throw new Error(`GitHub said ${response.status} for ${path || "the repository"}${response.status === 403 ? " (its rate limit, most likely; try again in a while)" : ""}.`);
    const listing = await response.json() as Array<{ type: string; path: string; size: number; download_url: string | null }> | { type: string };
    if (!Array.isArray(listing)) throw new Error("That address is a file; give the skill's folder, or its SKILL.md.");
    for (const item of listing) {
      if (SKIP.has(item.path.split("/").pop()!)) continue;
      if (item.type === "dir") { await walk(item.path); continue; }
      if (item.type !== "file" || !item.download_url) continue;
      if (files.length >= MAX_FILES || total + item.size > MAX_BYTES) throw new Error(`That skill is too big to review (over ${MAX_FILES} files or ${MAX_BYTES / 1024 / 1024} MB).`);
      total += item.size;
      const file = await fetch(item.download_url, { headers: { "user-agent": "perry-skill-import" } });
      if (!file.ok) throw new Error(`Could not download ${item.path} (${file.status}).`);
      files.push({ path: folder ? item.path.slice(folder.length + 1) : item.path, bytes: Buffer.from(await file.arrayBuffer()) });
    }
  };
  await walk(folder);
  return files;
}

/** The files of the skill at `source`: a folder on this computer, a GitHub folder or SKILL.md, or any SKILL.md address. */
async function load(source: string): Promise<Loaded[]> {
  const where = source.trim();
  if (!/^https?:\/\//i.test(where)) {
    const path = resolve(where.replace(/^~(?=$|[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? "~"));
    if (!existsSync(path)) throw new Error(`There is no folder at ${path}.`);
    const folder = statSync(path).isDirectory() ? path : dirname(path);
    return readFolder(folder);
  }
  const url = new URL(where);
  const github = url.hostname === "github.com" && url.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)\/?(.*)$/);
  if (github) {
    const [, owner, repo, ref, rest] = github;
    const folder = rest.replace(/\/$/, "");
    return await readGitHub(owner, repo, ref, /(^|\/)SKILL\.md$/i.test(folder) ? folder.split("/").slice(0, -1).join("/") : folder);
  }
  const raw = url.hostname === "raw.githubusercontent.com" && url.pathname.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.*)\/SKILL\.md$/i);
  if (raw) return await readGitHub(raw[1], raw[2], raw[3], raw[4]);
  const response = await fetch(url, { headers: { "user-agent": "perry-skill-import" } });
  if (!response.ok) throw new Error(`That address answered ${response.status}.`);
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error("That file is too big to be a skill.");
  return [{ path: "SKILL.md", bytes: Buffer.from(text) }];
}

/** What the skill's files say they do: commands, sites, paths, scripts, and warning signs. */
function scan(files: Loaded[]): Found {
  const found: Found = { commands: [], sites: [], paths: [], scripts: [], warnings: [] };
  const add = (list: string[], value: string, cap = 30) => { if (list.length < cap && !list.includes(value)) list.push(value); };
  for (const file of files) {
    if (SCRIPT.test(file.path)) add(found.scripts, file.path);
    if (!TEXT.test(file.path)) { add(found.warnings, `${file.path} is not text, so it cannot be read here`); continue; }
    const text = file.bytes.toString("utf8");
    for (const block of text.matchAll(SHELL_BLOCK)) {
      for (const line of block[1].split(/\r?\n/)) if (line.trim() && !line.trim().startsWith("#")) add(found.commands, line.trim().replace(/^\$\s+/, "").slice(0, 200));
    }
    for (const site of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) add(found.sites, site[1].toLowerCase());
    for (const path of text.matchAll(/(?:^|[\s`'"(])((?:~|\/(?:etc|usr|var|home|Users|tmp|opt)|[A-Z]:\\)[^\s`'")]*)/g)) add(found.paths, path[1].slice(0, 160));
    for (const [pattern, why] of WARNINGS) if (pattern.test(text)) add(found.warnings, `${file.path} ${why}`);
  }
  return found;
}

/** Fetch the skill at `source` into a review folder of its own, and say what it is and does. */
export async function stageSkill(source: string): Promise<Staged> {
  const files = await load(source);
  const skillFile = files.find((file) => file.path.toLowerCase() === "skill.md");
  if (!skillFile) throw new Error("There is no SKILL.md there, so it is not a skill (a skill is a folder with a SKILL.md at its top).");
  const skill = skillFile.bytes.toString("utf8");
  const { name, description } = frontmatter(skill);
  if (!name || !NAME.test(name)) throw new Error("Its SKILL.md has no usable name in its frontmatter (lowercase letters, digits and hyphens), so Codex would ignore it.");
  if (!description) throw new Error("Its SKILL.md has no description in its frontmatter, so Codex would ignore it.");
  const reviewId = randomUUID().slice(0, 8);
  const folder = join(REVIEW, reviewId);
  for (const file of files) {
    const target = join(folder, "skill", ...file.path.split("/"));
    // A path that climbs out of the folder is not a file of this skill.
    if (relative(join(folder, "skill"), target).startsWith("..") || isAbsolute(relative(join(folder, "skill"), target))) throw new Error(`${file.path} points outside the skill's folder.`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }
  const staged: Staged = {
    reviewId, name, description, source,
    files: files.map((file) => ({ path: file.path, bytes: file.bytes.length })),
    skill: skill.slice(0, SHOWN_SKILL),
    others: files.filter((file) => file !== skillFile && TEXT.test(file.path)).slice(0, 12).map((file) => ({ path: file.path, text: file.bytes.toString("utf8").slice(0, SHOWN_OTHER) })),
    found: scan(files),
  };
  writeFileSync(join(folder, "review.json"), JSON.stringify({ reviewId, name, source, stagedAt: Date.now() }));
  return staged;
}

/** Move a reviewed skill into the skills folder. `replace` overwrites one of the same name. */
export function installStaged(reviewId: string, replace: boolean): { name: string; path: string } {
  if (!/^[0-9a-f]{8}$/.test(reviewId)) throw new Error("No skill is waiting with that review id; review it again with review_skill.");
  const folder = join(REVIEW, reviewId);
  if (!existsSync(join(folder, "review.json"))) throw new Error("No skill is waiting with that review id; review it again with review_skill.");
  const { name, source } = JSON.parse(readFileSync(join(folder, "review.json"), "utf8")) as { name: string; source: string };
  const target = join(PATHS.skills, name);
  if (existsSync(target)) {
    if (!replace) throw new Error(`There is already a skill called ${name}. Ask the owner whether to replace it, then pass replace.`);
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(PATHS.skills, { recursive: true });
  try {
    renameSync(join(folder, "skill"), target);
  } catch {
    cpSync(join(folder, "skill"), target, { recursive: true });
  }
  rmSync(folder, { recursive: true, force: true });
  // Written after the move, so a file of that name in the skill itself cannot say where it came from.
  writeFileSync(join(target, ORIGIN), JSON.stringify({ source, installedAt: Date.now() }));
  return { name, path: target };
}

// --- The skills installed -------------------------------------------------------------

/** What installing a skill from elsewhere leaves in its folder: where it came from, and when. */
const ORIGIN = ".perry-source.json";
/** The most of a SKILL.md Apps & skills → Skills shows. */
const SHOWN_READ = 200_000;

export type InstalledSkill = {
  /** Its folder in the skills folder, which removing it deletes. */
  folder: string;
  /** Its name as the engines read it, which "$name" in a message uses: its SKILL.md's, else its folder's. */
  name: string;
  description: string;
  /** Where it was imported from (install_skill). Unset: Perry wrote it, or it was put in the folder by hand. */
  source?: string;
  /** When it was installed, or its SKILL.md first written. */
  addedAt: number;
  /** Why the engines pass it over: a SKILL.md with no usable name or description. */
  problem?: string;
};

/** A folder in the skills folder by its name alone, so nothing outside it can be read or removed. */
function skillFolder(folder: string): string {
  if (!folder || folder.startsWith(".") || /[\\/:]/.test(folder)) throw new Error("That is not a skill's folder.");
  const path = join(PATHS.skills, folder);
  if (!existsSync(join(path, "SKILL.md"))) throw new Error(`There is no skill in ${folder} any more.`);
  return path;
}

function describe(folder: string): InstalledSkill {
  const path = join(PATHS.skills, folder);
  const { name, description } = frontmatter(readFileSync(join(path, "SKILL.md"), "utf8"));
  let origin: { source?: unknown; installedAt?: unknown } = {};
  try { origin = JSON.parse(readFileSync(join(path, ORIGIN), "utf8")); } catch {}
  const usable = Boolean(name && NAME.test(name));
  return {
    folder,
    name: usable ? name! : folder,
    description: description ?? "",
    ...(typeof origin.source === "string" ? { source: origin.source } : {}),
    addedAt: typeof origin.installedAt === "number" ? origin.installedAt : statSync(join(path, "SKILL.md")).birthtimeMs,
    ...(!usable ? { problem: "Its SKILL.md names no skill (lowercase letters, digits and hyphens), so the engines pass it over." }
      : !description ? { problem: "Its SKILL.md has no description, so the engines pass it over." } : {}),
  };
}

/** Every skill in the skills folder, by name: one folder each, with a SKILL.md at its top. */
export function listSkills(): InstalledSkill[] {
  let entries;
  try { entries = readdirSync(/*turbopackIgnore: true*/ PATHS.skills, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && existsSync(join(PATHS.skills, entry.name, "SKILL.md")))
    .map((entry) => describe(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One skill, with its SKILL.md and the files beside it, for the owner to read. */
export function readSkill(folder: string): InstalledSkill & { path: string; skill: string; files: Array<{ path: string; bytes: number }> } {
  const root = skillFolder(folder);
  const files: Array<{ path: string; bytes: number }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.name === ORIGIN || files.length >= MAX_FILES) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push({ path: relative(root, path).split(sep).join("/"), bytes: statSync(path).size });
    }
  };
  walk(root);
  const skill = readFileSync(join(root, "SKILL.md"), "utf8");
  return { ...describe(folder), path: join(root, "SKILL.md"), skill: skill.slice(0, SHOWN_READ), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Delete a skill, its whole folder. The engines stop seeing it from their next message. */
export function removeSkill(folder: string): { name: string } {
  const root = skillFolder(folder);
  const { name } = describe(folder);
  rmSync(root, { recursive: true, force: true });
  return { name };
}

/** The installed skills a message names with "$name", each with the SKILL.md its engine is to read. */
export function skillsNamedIn(text: string): Array<{ name: string; path: string }> {
  const named = skillMentions(text);
  if (!named.length) return [];
  const usable = listSkills().filter((skill) => !skill.problem);
  return named.flatMap((name) => {
    const skill = usable.find((item) => item.name === name);
    return skill ? [{ name, path: join(PATHS.skills, skill.folder, "SKILL.md") }] : [];
  });
}
