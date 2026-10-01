import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep } from "../browser";

// bun artifacts/pet-update/run.ts <outDir>
// `perry update` and the desktop pet: when the pet's own files changed, a
// running pet starts again on them; otherwise it only reloads its page. A
// fresh Perry (production build, `pnpm build` first) with its own PERRY_HOME,
// and real pets (Electron) started from this checkout, and one from the pet
// files on main before this change, which knows nothing of --restart. Windows
// only: pets are found by their command lines.
//
// Ways it could fail, written down before the checks:
//   1. A pet whose files changed only reloads, and keeps running its old code.
//   2. Restarting leaves no pet: the old one quits and the new one never takes
//      its place; or leaves two.
//   3. An update restarts a pet that was not running, so turning him off does
//      not stick.
//   4. A pet from before this change ignores the restart.
//   5. Nothing changed in pet/, and the pet restarts anyway; or the reload
//      stops it.
//   6. Telling what changed gets it wrong: no restart after pet/ changed, or a
//      restart when it did not.
//   7. The owner's own pet is touched.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/pet-update/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });
if (process.platform !== "win32") throw new Error("This check finds pets by their Windows command lines; run it on Windows.");

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PET = join(REPO, "pet");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const PORT = await freePort();
const DEVTOOLS = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "pet-update-e2e-key";
const home = mkdtempSync(join(tmpdir(), "perry-pet-update-"));
// Away from the bottom-right corner, where the owner's own pet may be standing.
writeFileSync(join(home, "pet.json"), JSON.stringify({ x: 40, y: 60 }));
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; };

const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PERRY_PORT: String(PORT), DASHBOARD_KEY: KEY, NODE_ENV: "production", PERRY_ENGINE: "codex", PERRY_BUN: process.execPath, PERRY_PET_DEVTOOLS_PORT: String(DEVTOOLS) };
for (const name of Object.keys(env)) if (name.startsWith("CONVEX") || name === "TELEGRAM_BOT_TOKEN" || name === "COMPOSIO_API_KEY" || name === "ELECTRON_RUN_AS_NODE") delete env[name];
const ps = (script: string) => spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).stdout.trim();
/** Pet processes (not Electron's helpers) started from a folder, by process id. */
const petsIn = (folder: string) => ps(`Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -like '*${folder.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`).split(/\s+/).filter(Boolean).sort();
/** Every pet that is not this checkout's or the old copy's: the owner's own. */
let oldPet = "";
const ownersPets = () => ps(`Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notlike '*${REPO.replace(/'/g, "''")}*' -and $_.CommandLine -notlike '*perry-pet-old*' } | ForEach-Object { $_.ProcessId }`).split(/\s+/).filter(Boolean).sort();
const petPage = () => fetch(`http://127.0.0.1:${DEVTOOLS}/json/list`).then((r) => r.json() as Promise<Array<{ url: string }>>).then((list) => list.some((item) => item.url.startsWith(`${BASE}/pet`)), () => false);
const stop = (child: ChildProcess | null) => { if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); };
const perry = (...args: string[]) => spawnSync(process.execPath, [join(REPO, "scripts", "perry.ts"), ...args], { cwd: REPO, env, encoding: "utf8", windowsHide: true, timeout: 600_000 });
/** What `perry update` does for the pet, run as it runs it. */
const refresh = (restart: boolean) => spawnSync(process.execPath, ["-e", `const pet = await import(${JSON.stringify(join(REPO, "scripts", "pet.ts"))}); await pet.refresh({ restart: ${restart} });`], { cwd: REPO, env, encoding: "utf8", windowsHide: true, timeout: 600_000 });
const changedSince = (from: string) => spawnSync(process.execPath, ["-e", `const pet = await import(${JSON.stringify(join(REPO, "scripts", "pet.ts"))}); console.log(JSON.stringify(pet.changedSince(${JSON.stringify(from)})));`], { cwd: REPO, env, encoding: "utf8", windowsHide: true }).stdout.trim().split(/\r?\n/).pop();
async function until(test: () => Promise<boolean> | boolean, what: string, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await Promise.resolve().then(test).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`timed out: ${what}`);
}
const ownersBefore = ownersPets();

const server = spawn("node", [join(REPO, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: REPO, env, stdio: "ignore", windowsHide: true });
let old: ChildProcess | null = null;
try {
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);

  // --- 6. Telling what changed -------------------------------------------------------------------------------
  const base = spawnSync("git", ["merge-base", "HEAD", "origin/main"], { cwd: REPO, encoding: "utf8" }).stdout.trim();
  check("tellsWhenPetChanged", changedSince(base) === "true" && changedSince("HEAD") === "false", { sinceMain: changedSince(base), sinceHead: changedSince("HEAD") });

  // --- 5. Nothing changed: the same pet, its page reloaded -------------------------------------------------------
  notes.perryPet = perry("pet").stdout.replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\r?\n/).slice(-2);
  await until(petPage, "the pet", 120);
  await until(() => petsIn(PET).length === 1, "one pet", 20).catch(() => {});
  const first = petsIn(PET);
  refresh(false);
  await sleep(4_000);
  check("reloadKeepsThePet", first.length === 1 && JSON.stringify(petsIn(PET)) === JSON.stringify(first) && await petPage(), { first, now: petsIn(PET) });

  // --- 1, 2. His files changed: a new pet in his place ------------------------------------------------------------------
  refresh(true);
  await until(async () => petsIn(PET).length === 1 && petsIn(PET)[0] !== first[0] && await petPage(), "the new pet", 40).catch(() => {});
  const second = petsIn(PET);
  check("restartReplacesThePet", second.length === 1 && second[0] !== first[0] && await petPage(), { first, second });

  // --- 4. A pet from before this change: it quits on --quit, and the new code takes over -----------------------------
  perry("pet", "off");
  await until(() => petsIn(PET).length === 0, "the pet to quit", 20).catch(() => {});
  oldPet = mkdtempSync(join(tmpdir(), "perry-pet-old-"));
  for (const file of ["main.js", "preload.cjs", "voice.js", "look.js", "package.json"]) {
    const content = spawnSync("git", ["show", `${base}:pet/${file}`], { cwd: REPO, encoding: "utf8" });
    if (content.status === 0) writeFileSync(join(oldPet, file), content.stdout);
  }
  cpSync(join(PET, "icon.png"), join(oldPet, "icon.png"));
  cpSync(join(PET, "icon@2x.png"), join(oldPet, "icon@2x.png"));
  symlinkSync(join(PET, "node_modules"), join(oldPet, "node_modules"), "junction");
  old = spawn(join(PET, "node_modules", "electron", "dist", "electron.exe"), [oldPet], { cwd: oldPet, env: { ...env, PERRY_PORT: String(PORT) }, stdio: "ignore", detached: true });
  old.unref();
  await until(async () => petsIn(oldPet).length === 1 && await petPage(), "the old pet", 60).catch(() => {});
  const olds = petsIn(oldPet);
  refresh(true);
  await until(async () => petsIn(oldPet).length === 0 && petsIn(PET).length === 1 && await petPage(), "the new code in the old one's place", 40).catch(() => {});
  check("oldPetIsReplacedByTheNewCode", olds.length === 1 && petsIn(oldPet).length === 0 && petsIn(PET).length === 1 && await petPage(), { olds, oldNow: petsIn(oldPet), newNow: petsIn(PET) });

  // --- 3. Not running: an update starts no pet ----------------------------------------------------------------------
  perry("pet", "off");
  await until(() => petsIn(PET).length === 0, "the pet to quit", 20).catch(() => {});
  refresh(true);
  await sleep(8_000);
  check("noPetStartsWhenNoneRan", petsIn(PET).length === 0 && petsIn(oldPet).length === 0 && !(await petPage()), { now: petsIn(PET) });

  // --- 7. The owner's own ------------------------------------------------------------------------------------------------
  check("ownersPetUntouched", JSON.stringify(ownersPets()) === JSON.stringify(ownersBefore), { before: ownersBefore, after: ownersPets() });
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  perry("pet", "off");
  for (const pid of [...petsIn(PET), ...(oldPet ? petsIn(oldPet) : [])]) spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
  stop(server);
  await sleep(2_000);
  // The old copy borrows this checkout's packages through a junction: the link goes, never what it points to.
  if (oldPet) { try { unlinkSync(join(oldPet, "node_modules")); } catch {} }
  for (const dir of [home, oldPet].filter(Boolean)) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {} }
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed, stoppedAt: notes.stoppedAt }, null, 2));
process.exit(result.passed ? 0 : 1);
