import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Assistant's home on this machine, the way Claude Code has ~/.claude and
 * Codex has ~/.codex. Created on setup and whenever the runner starts, and
 * shared by the runner and the dashboard's local media server, so a file
 * anywhere in here can be shown in chat and served from where it is.
 *
 *   runner.json     how this machine's runner connects
 *   codex-results/  finished Codex turns not yet delivered
 *   uploads/        files the owner attached in chat
 *   files/          the agent's own folder for what it makes, organised as it sees fit
 *
 * PERRY_HOME moves the whole thing.
 */
export const HOME = process.env.PERRY_HOME ?? join(homedir(), ".perry");

export const PATHS = {
  runnerConfig: join(HOME, "runner.json"),
  codexResults: join(HOME, "codex-results"),
  uploads: join(HOME, "uploads"),
  files: join(HOME, "files"),
};

export function ensureHome() {
  for (const dir of [HOME, PATHS.codexResults, PATHS.uploads, PATHS.files]) mkdirSync(dir, { recursive: true });
  return PATHS;
}
