import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import crons from "../convex/crons";
import http from "../convex/http";
import schema from "../convex/schema";
import { HOME, readRunnerConfig, writeRunnerConfig } from "../runner/home";
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

/** Start the scheduler, crons, Telegram, WhatsApp, event triggers and the wake timer. Called once, from instrumentation.ts. */
export async function startBackend() {
  const runtime = backend();
  if (box.__perry!.started) return;
  box.__perry!.started = true;
  await runtime.runMutation("installation:ensure", {}, { internal: true });
  // A chat from before projects that kept its memory to itself becomes a project of its own.
  await runtime.runMutation("projects:migrate", {}, { internal: true });
  await pairThisMachine(runtime).catch((error) => console.error(`[perry] could not connect this computer: ${String(error)}`));
  runtime.start();
  box.__perry!.stopTelegram = pollTelegram(runtime);
  box.__perry!.stopWhatsApp = runWhatsApp(runtime);
  box.__perry!.stopTriggers = runTriggers(runtime);
  box.__perry!.stopWake = runWake(runtime);
  console.log(`[perry] backend ready: ${runtime.functions().length} functions, data in ${HOME}`);
}
