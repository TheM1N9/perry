import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import crons from "../convex/crons";
import http from "../convex/http";
import schema from "../convex/schema";
import { HOME, PATHS, readRunnerConfig, writeRunnerConfig } from "../runner/home";
import { moveVectorsOut } from "./brainIndex";
import { modules } from "./modules";
import { Runtime } from "./runtime";
import { pollTelegram } from "./telegram";
import { runTriggers } from "./triggers";
import { runWake } from "./wake";
import { runWhatsApp } from "./whatsapp";

/**
 * Perry's backend, inside the dashboard's server process: one SQLite file in
 * ~/.perry, the functions in convex/, their scheduler and crons, Telegram and WhatsApp.
 * This process is the only one that opens the database; the runner, the CLI
 * and the browser all go through /api/backend.
 */

export const PORT = Number(process.env.PERRY_PORT ?? process.env.PORT ?? 7377);
/** This server as the runner on this machine reaches it. */
export const LOCAL_URL = `http://127.0.0.1:${PORT}`;

type Global = { __perry?: { runtime: Runtime; started: boolean; stopTelegram?: () => void; stopWhatsApp?: () => void; stopTriggers?: () => void; stopWake?: () => void } };
const box = globalThis as Global;

export function backend(): Runtime {
  if (!box.__perry) {
    mkdirSync(HOME, { recursive: true });
    const sql = new DatabaseSync(process.env.PERRY_DB ?? join(HOME, "perry.sqlite"));
    const runtime = new Runtime(sql, schema as never, modules, {
      storageDir: join(HOME, "storage"),
      crons: crons as never,
      http: http as never,
    });
    box.__perry = { runtime, started: false };
  }
  return box.__perry.runtime;
}

/**
 * The runner on this machine connects to this server with a token like any
 * other; here it gets one without asking, as a process on the same machine and
 * user already could read everything in ~/.perry. A runner.json pointing
 * somewhere else (the old Convex deployment) is moved over, keeping its folder.
 * One whose token this server knows is already this machine's runner, only at
 * an old address (Perry's port moved from 3000): it keeps its token, so its
 * chats stay with it.
 */
async function pairThisMachine(runtime: Runtime) {
  const config = readRunnerConfig();
  if (config.token) {
    const known = await runtime.exclusive(() =>
      runtime.store.query("runners").withIndex("by_token", (q) => q.eq("token", config.token)).first());
    if (known && !known.revoked) {
      if (config.url !== LOCAL_URL) writeRunnerConfig({ ...config, url: LOCAL_URL });
      return;
    }
  }
  const token = randomBytes(32).toString("base64url");
  const name = config.name ?? hostname();
  const dir = config.dir ?? join(HOME, "workspace");
  mkdirSync(dir, { recursive: true });
  await runtime.runMutation("runner:createToken", { name, token }, { internal: true });
  writeRunnerConfig({ ...config, url: LOCAL_URL, token, name, dir });
  console.log(`[perry] connected this computer (${name}) to the local backend`);
}

/**
 * Memories from before pages are moved into them (pages.migrate, issue #210):
 * first every row of memory, USER.md's versions and every page are written to
 * ~/.perry/backups/memories-before-pages-<time>.json, then each memory waiting
 * for its page gets one. Nothing is deleted, and `perry brain move-back`
 * undoes the move. Does nothing once done, or after the owner moved them back.
 * A failure is said and leaves memory as it was, still loaded and recalled.
 */
export async function moveMemoriesIntoPages(runtime: Runtime): Promise<void> {
  try {
    const waiting = await runtime.exclusive(() => {
      const undone = runtime.store.all("installation").some((row) => row.memoriesInPages === "undone");
      const loose = runtime.store.all("memories").filter((row) => !row.pageId && !row.supersededBy && row.kind !== "page");
      return undone ? [] : loose;
    });
    if (!waiting.length) return;
    const backup = await runtime.exclusive(() => ({
      at: new Date().toISOString(),
      waiting: waiting.length,
      memories: runtime.store.all("memories"),
      persona: runtime.store.all("persona"),
      notes: runtime.store.all("notes"),
    }));
    const dir = join(HOME, "backups");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `memories-before-pages-${backup.at.replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify(backup));
    const done = await runtime.runMutation("pages:migrate", {}, { internal: true }) as { moved: number; kept: number; pages: number };
    console.log(`[perry] moved ${done.moved} memories into pages${done.kept ? ` (${done.kept} kept as they were)` : ""}; backup in ${file}`);
  } catch (error) {
    console.error(`[perry] could not move memories into pages; they stay as they were: ${String(error)}`);
  }
}

/**
 * Everyone a memory names gets a page in People (pages.fixPeople, issue #218),
 * on installs moved into pages before that: first the memories, the pages and
 * the contacts are written to ~/.perry/backups/people-before-pages-<time>.json,
 * then the missing pages are made. It only adds pages. Nothing once done.
 */
export async function givePeoplePages(runtime: Runtime): Promise<void> {
  try {
    const missing = (await runtime.runQuery("pages:peopleMissing", {}, { internal: true })).value as number;
    if (!missing) return;
    const backup = await runtime.exclusive(() => ({
      at: new Date().toISOString(),
      missing,
      memories: runtime.store.all("memories"),
      notes: runtime.store.all("notes"),
      contacts: runtime.store.all("contacts"),
    }));
    const dir = join(HOME, "backups");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `people-before-pages-${backup.at.replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify(backup));
    const done = await runtime.runMutation("pages:fixPeople", {}, { internal: true }) as { made: number };
    console.log(`[perry] gave ${done.made} people a page in Brain; backup in ${file}`);
  } catch (error) {
    console.error(`[perry] could not give people their pages; nothing changed: ${String(error)}`);
  }
}

/**
 * The default engine the owner chose in `perry setup` while Perry was not
 * running, waiting in Perry's home: it becomes the default, once.
 */
async function engineFromSetup(runtime: Runtime) {
  if (!existsSync(/*turbopackIgnore: true*/ PATHS.engineChoice)) return;
  try {
    const { engine } = JSON.parse(readFileSync(/*turbopackIgnore: true*/ PATHS.engineChoice, "utf8")) as { engine?: string };
    await runtime.runMutation("installation:setDefaultEngine", { engine }, { internal: true });
  } catch (error) {
    console.error(`[perry] could not take the default engine perry setup chose: ${String(error)}`);
  }
  rmSync(/*turbopackIgnore: true*/ PATHS.engineChoice, { force: true });
}

/**
 * PERRY_ENGINE in the server's own environment names the default engine of
 * an install that has none chosen yet, as `perry setup --engine` does: a
 * choice whoever started it made (a test Perry, a scripted install), never a
 * guess. One already chosen is left as it is.
 */
async function engineFromEnvironment(runtime: Runtime) {
  const named = process.env.PERRY_ENGINE?.trim().toLowerCase();
  if (!named) return;
  const install = (await runtime.runQuery("installation:get", {}, { internal: true })).value as { defaultEngine?: string } | null;
  if (install?.defaultEngine) return;
  await runtime.runMutation("installation:setDefaultEngine", { engine: named }, { internal: true })
    .catch((error) => console.error(`[perry] PERRY_ENGINE=${named} is not an engine Perry can use: ${String(error)}`));
}

/**
 * Brain's index brought up to date (issue #220): vectors from inside the rows
 * moved to the vector index, after a backup (server/brainIndex.ts); who each
 * line mentions read for lines from before (pages.indexMentions, in batches).
 * The word index builds itself when the store opens (server/db.ts). A failure
 * is said and leaves Brain searchable by words, its lines embedded again.
 */
export async function updateBrainIndex(runtime: Runtime): Promise<void> {
  try {
    const done = await moveVectorsOut(runtime);
    if (done.moved || done.dropped) console.log(`[perry] moved ${done.moved} vectors out of Brain's rows into its vector index (${done.dropped} to make again); backup in ${done.backup}`);
  } catch (error) {
    console.error(`[perry] could not move Brain's vectors; its lines are embedded again instead: ${String(error)}`);
  }
  await runtime.runMutation("pages:indexMentions", {}, { internal: true }).catch((error) => console.error(`[perry] could not read who Brain's lines mention: ${String(error)}`));
}

/** Start the scheduler, crons, Telegram, WhatsApp, event triggers and the wake timer. Called once, from instrumentation.ts. */
export async function startBackend() {
  const runtime = backend();
  if (box.__perry!.started) return;
  box.__perry!.started = true;
  // Also brings an install from before the default engine was asked for forward: Codex, as it was, written down.
  await runtime.runMutation("installation:ensure", {}, { internal: true });
  await engineFromSetup(runtime);
  await engineFromEnvironment(runtime);
  // A chat from before projects that kept its memory to itself becomes a project of its own.
  await runtime.runMutation("projects:migrate", {}, { internal: true });
  // Every note's paragraphs as lines that search finds with the memories (pages.ts); nothing once done.
  await runtime.runMutation("pages:indexAll", {}, { internal: true });
  // Memories from before pages move into them, after a backup.
  await moveMemoriesIntoPages(runtime);
  await givePeoplePages(runtime);
  await pairThisMachine(runtime).catch((error) => console.error(`[perry] could not connect this computer: ${String(error)}`));
  runtime.start();
  // In the background, so years of Brain never hold up the dashboard: its index brought up to date, then the lines
  // without a vector from the model in use (new ones, or all of them after the model changed) embedded.
  void updateBrainIndex(runtime)
    .then(() => runtime.runAction("memories:embedMissing", {}, { internal: true }))
    .catch((error) => console.error(`[perry] could not embed Brain's lines: ${String(error)}`));
  box.__perry!.stopTelegram = pollTelegram(runtime);
  box.__perry!.stopWhatsApp = runWhatsApp(runtime);
  box.__perry!.stopTriggers = runTriggers(runtime);
  box.__perry!.stopWake = runWake(runtime);
  console.log(`[perry] backend ready: ${runtime.functions().length} functions, data in ${HOME}`);
}
