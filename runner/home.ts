import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 *   skills/         the agent's skills, one folder each with a SKILL.md, found by Codex
 *   logs/           the runner's output when it runs as a background service
 *
 * PERRY_HOME moves the whole thing.
 */
export const HOME = process.env.PERRY_HOME ?? join(homedir(), ".perry");

export const PATHS = {
  runnerConfig: join(HOME, "runner.json"),
  codexResults: join(HOME, "codex-results"),
  uploads: join(HOME, "uploads"),
  files: join(HOME, "files"),
  skills: join(HOME, "skills"),
  logs: join(HOME, "logs"),
};

export function ensureHome() {
  for (const dir of [HOME, PATHS.codexResults, PATHS.uploads, PATHS.files, PATHS.skills]) mkdirSync(dir, { recursive: true });
  return PATHS;
}

/** How this machine's runner connects. Written by Perry's server, the runner and `pnpm run connect`. */
export type RunnerConfig = { url?: string; token?: string; dir?: string; name?: string; auto?: boolean };

export function readRunnerConfig(): RunnerConfig {
  // Perry's home, not the project: nothing here belongs in the server build's file trace.
  if (!existsSync(/*turbopackIgnore: true*/ PATHS.runnerConfig)) return {};
  try {
    return JSON.parse(readFileSync(/*turbopackIgnore: true*/ PATHS.runnerConfig, "utf8"));
  } catch {
    return {};
  }
}

export function writeRunnerConfig(config: RunnerConfig) {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(PATHS.runnerConfig, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
}
