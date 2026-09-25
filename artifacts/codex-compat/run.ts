import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { CodexAppServer } from "../../runner/codex";

// bun artifacts/codex-compat/run.ts <outDir>
// Starts the runner's own Codex client (CodexAppServer) against Codex 0.106.0,
// fetched with pnpm dlx, and against whatever `codex` is on PATH. Each runs
// with CODEX_HOME in a fresh temp folder, so this machine's sign-in is never
// read or touched. Needs pnpm, and network the first time 0.106.0 is fetched.
//
// Ways the runner could fail on an older Codex, and what catches each:
//   1. The app-server will not start (a flag it does not know, such as
//      --stdio, exits it with code 2): start() must finish its initialize.
//   2. It starts but cannot be talked to: account() (account/read) must answer.
//   3. A method the older Codex lacks takes the runner down with it: Perry's
//      skills (skills/extraRoots/set, missing in 0.106) must fail on their own,
//      as "unknown variant", with the app-server still answering afterwards.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/codex-compat/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const windows = process.platform === "win32";
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};

/** Put a `codex` first on PATH that runs this version, for the runner to find. */
function shim(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), `codex-${version}-`));
  if (windows) writeFileSync(join(dir, "codex.cmd"), `@pnpm dlx @openai/codex@${version} %*\r\n`);
  else writeFileSync(join(dir, "codex"), `#!/bin/sh\nexec pnpm dlx @openai/codex@${version} "$@"\n`, { mode: 0o755 });
  return dir;
}

async function probe(label: string, version?: string) {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const bin = version ? shim(version) : null;
  const saved = { PATH: process.env.PATH, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CODEX_HOME = home;
  if (bin) process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  const result: Record<string, unknown> = {};
  const codex = new CodexAppServer();
  try {
    await codex.start();
    result.started = true;
    result.account = await codex.account();
    result.skills = await codex.useSkills().then(() => "loaded", (error: Error) => error.message);
    result.answersAfterSkills = Boolean(await codex.account());
  } catch (error) {
    result.error = (error as Error).message;
  } finally {
    codex.close();
    process.env.PATH = saved.PATH;
    if (saved.CODEX_HOME === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved.CODEX_HOME;
    // Codex can hold its home a moment after closing (Windows); a leftover temp folder is harmless.
    for (const dir of [home, bin]) if (dir) try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
  }
  notes[label] = result;
  return result;
}

const old = await probe("codex 0.106.0", "0.106.0");
checks.oldCodexStarts = old.started === true;
checks.oldCodexAnswers = (old.account as { available?: boolean } | undefined)?.available === true;
checks.oldCodexSkillsFailAlone = typeof old.skills === "string" && /unknown variant/.test(old.skills) && old.answersAfterSkills === true;

const current = await probe("codex on PATH");
checks.currentCodexStarts = current.started === true;
checks.currentCodexLoadsSkills = current.skills === "loaded";

const result = { ranAt: new Date().toISOString(), platform: process.platform, checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
process.exit(result.passed ? 0 : 1);
