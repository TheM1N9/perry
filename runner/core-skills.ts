import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME, PATHS } from "./home";

/**
 * Perry's own skills (skills/ in this repository, such as scroll), put into
 * the skills folder every engine reads, when the runner starts.
 *
 * A copy whose frontmatter still says `perry: core` (under metadata) is
 * Perry's: it is replaced when Perry's own changes. One the owner changed and
 * unmarked is theirs and left alone, and one the owner removed stays removed:
 * core-skills.json remembers which were installed once.
 */
const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
const CORE = /^metadata:[ \t]*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+perry:[ \t]*core[ \t]*\r?$/m;

export function installCoreSkills(from = SHIPPED, to = PATHS.skills, record = join(HOME, "core-skills.json")): string[] {
  if (!existsSync(from)) return [];
  let installed: Record<string, true> = {};
  try { installed = JSON.parse(readFileSync(record, "utf8")); } catch { /* none yet */ }
  const changed: string[] = [];
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const shipped = join(from, entry.name, "SKILL.md");
    if (!existsSync(shipped)) continue;
    const skill = readFileSync(shipped, "utf8");
    const target = join(to, entry.name, "SKILL.md");
    if (existsSync(target)) {
      const current = readFileSync(target, "utf8");
      if (current === skill || !CORE.test(current)) { installed[entry.name] = true; continue; }
    } else if (installed[entry.name]) continue;
    mkdirSync(to, { recursive: true });
    cpSync(join(from, entry.name), join(to, entry.name), { recursive: true, force: true });
    installed[entry.name] = true;
    changed.push(entry.name);
  }
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(record, JSON.stringify(installed, null, 2));
  return changed;
}
