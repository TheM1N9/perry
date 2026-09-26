import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// bun artifacts/uninstall/run.ts <outDir> [branch] [origin]
// Runs `perry uninstall` for real, each time on a fresh clone of <branch>
// (default: the current one, which must be pushed) in a temp folder, with
// PERRY_HOME in that folder too. Pass the branch and origin where git cannot
// read this checkout (WSL on a Windows worktree). On Linux, HOME is a temp folder as well
// (the shell files it cleans), `systemctl` is a stub that only records what
// it was asked, and the interactive cases run in a real terminal (`script`).
// On Windows only the flag and no-terminal cases run; the "Perry runner" task
// it deletes does not exist here, and PERRY_HOME\bin is not on the real PATH,
// so neither is touched. Nothing outside the temp folder is.
//
// Ways it could fail the owner, and what catches each:
//   1. It uninstalls without a choice being made: with no terminal and no
//      flag it must stop, change nothing, and say which flags to use.
//   2. A wrong answer is taken as a choice: in a terminal, Enter and "3" must
//      be asked again, until 1 or 2.
//   3. "Keep files" deletes files: 1 must remove the service and the perry
//      command only, leaving the checkout, PERRY_HOME's data and the shell's
//      PATH lines.
//   4. Removal happens without being meant: 2 followed by anything but
//      "remove" must change nothing, not even the service.
//   5. "Remove" leaves Perry behind, or takes more than Perry: 2 and "remove"
//      must delete the checkout and PERRY_HOME, and take out only the
//      "# added by Perry" lines of the shell files.
//   6. A developer's checkout is deleted with their work: with uncommitted
//      changes, --remove-files must keep the checkout and say why, while still
//      removing PERRY_HOME.
//   7. The flags do not work without a terminal: --keep-files and
//      --remove-files must each do their part with no questions.
//   8. Removing loses data without saying so: Perry's data is its database in
//      PERRY_HOME, so the menu must say option 2 deletes the chats and memory,
//      and after it the database must be gone.
//   9. It sends people to Convex that is not there, or forgets one that is:
//      Convex is named only when .env.local still names a deployment (an
//      install never moved off it), and then both before and after removing.

const [outDir, branchArg, originArg] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/uninstall/run.ts <outDir> [branch] [origin]");
mkdirSync(outDir, { recursive: true });

const here = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (args: string[], cwd = here) => spawnSync("git", args, { cwd, encoding: "utf8" });
const origin = originArg ?? git(["remote", "get-url", "origin"]).stdout.trim();
const branch = branchArg ?? git(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
const linux = process.platform === "linux";
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = { platform: process.platform, origin, branch };

type World = { root: string; repo: string; home: string; userHome: string; env: NodeJS.ProcessEnv; log: string };

function world(): World {
  const root = mkdtempSync(join(tmpdir(), "perry-uninstall-"));
  const repo = join(root, "perry");
  const cloned = git(["clone", "-q", "--depth", "1", "--branch", branch, origin, repo], root);
  if (cloned.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`clone failed: ${cloned.stderr}`);
  }
  const home = join(root, ".perry");
  for (const dir of ["bin", "files", "uploads", "skills"]) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, "bin", "perry"), "#!/bin/sh\n");
  writeFileSync(join(home, "bin", "perry.cmd"), "@echo off\r\n");
  writeFileSync(join(home, "files", "made.txt"), "something Perry made");
  writeFileSync(join(home, "runner.json"), "{}");
  writeFileSync(join(home, "perry.sqlite"), "all of Perry's data");
  const userHome = join(root, "user");
  mkdirSync(userHome);
  writeFileSync(join(userHome, ".bashrc"), `alias ll='ls -l'\n\nexport PATH="$PATH:${home}/bin"  # added by Perry\nexport EDITOR=vim\n`);
  writeFileSync(join(userHome, ".profile"), `umask 022\n\nexport PATH="${home}/bin:$PATH"  # added by Perry\n`);
  const log = join(root, "systemctl.log");
  const stubs = join(root, "stubs");
  mkdirSync(stubs);
  writeFileSync(join(stubs, "systemctl"), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = { ...process.env, PERRY_HOME: home, PATH: `${stubs}${delimiter}${process.env.PATH}` };
  if (linux) env.HOME = userHome;
  return { root, repo, home, userHome, env, log };
}

const cli = (w: World) => [process.execPath, "--cwd", w.repo, join(w.repo, "scripts", "perry.ts"), "uninstall"];

/** No terminal: stdin is empty. */
function plain(w: World, flags: string[] = []) {
  const [cmd, ...args] = cli(w);
  const ran = spawnSync(cmd, [...args, ...flags], { cwd: w.repo, env: w.env, input: "", encoding: "utf8" });
  return { code: ran.status, output: `${ran.stdout}${ran.stderr}` };
}

const clean = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");

/** In a real terminal, answering each prompt as it appears. */
function terminal(w: World, answers: Array<{ when: RegExp; say: string }>): Promise<{ code: number | null; output: string; asked: number }> {
  const command = cli(w).map((part) => `'${part.replace(/'/g, "'\\''")}'`).join(" ");
  const child = spawn("script", ["-qec", command, "/dev/null"], { cwd: w.repo, env: w.env });
  let output = "";
  let next = 0;
  // Answer i goes once its prompt has appeared as many times as answers up to i wait for it.
  const need = answers.map((answer, i) => answers.slice(0, i + 1).filter((other) => other.when.source === answer.when.source).length);
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
    // Matched without colours, which can sit between the words of a prompt.
    while (next < answers.length && clean(output).split(answers[next].when).length - 1 >= need[next]) {
      const answer = answers[next++];
      setTimeout(() => child.stdin.write(`${answer.say}\r`), 150);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const timer = setTimeout(() => child.kill(), 60000);
  return new Promise((done) => child.on("close", (code) => { clearTimeout(timer); done({ code, output, asked: next }); }));
}

const intact = (w: World) => existsSync(join(w.repo, "scripts", "perry.ts")) && existsSync(join(w.home, "files", "made.txt")) && existsSync(join(w.home, "bin", "perry"));
const rcLines = (w: World) => [".bashrc", ".profile"].map((name) => readFileSync(join(w.userHome, name), "utf8"));
const worlds: World[] = [];
const make = () => { const w = world(); worlds.push(w); return w; };

try {
  // 1. No terminal, no flag.
  {
    const w = make();
    const ran = plain(w);
    notes.noChoice = clean(ran.output).split("\n").slice(-3);
    checks.noChoiceChangesNothing = ran.code !== 0 && intact(w) && /--keep-files/.test(ran.output) && !existsSync(w.log);
    // 8. The menu says what option 2 deletes; with no Convex deployment named, Convex is not mentioned.
    checks.menuSaysDataIsDeleted = /all of Perry's data/.test(clean(ran.output)) && /your chats, memory, USER\.md/.test(clean(ran.output));
    checks.noConvexWithoutOne = !/convex/i.test(ran.output);
  }

  // 7. The flags.
  {
    const w = make();
    const ran = plain(w, ["--keep-files"]);
    checks.keepFilesFlag = ran.code === 0 && existsSync(join(w.repo, "scripts", "perry.ts")) && existsSync(join(w.home, "files", "made.txt")) && !existsSync(join(w.home, "bin", "perry"));
  }
  {
    const w = make();
    const ran = plain(w, ["--remove-files"]);
    notes.removeFilesFlag = clean(ran.output).split("\n").slice(-6);
    checks.removeFilesFlag = ran.code === 0 && !existsSync(w.repo) && !existsSync(w.home) && !existsSync(join(w.home, "perry.sqlite"));
    checks.noConvexAfterRemoving = !/convex/i.test(ran.output);
  }

  // 9. An install that still names a Convex deployment is told it is untouched, before and after.
  {
    const w = make();
    writeFileSync(join(w.repo, ".env.local"), "DASHBOARD_KEY=x\nCONVEX_DEPLOYMENT=dev:e2e-123 # team: t, project: perry\n");
    const ran = plain(w, ["--remove-files"]);
    notes.convexInstall = clean(ran.output).split("\n").filter((line) => /Convex/.test(line));
    checks.namesConvexWhenThere = /still has data on Convex \(dev:e2e-123\)/.test(clean(ran.output))
      && /Its Convex deployment \(dev:e2e-123\) is still there/.test(clean(ran.output));
  }

  // 6. A checkout with work in it.
  {
    const w = make();
    writeFileSync(join(w.repo, "my-notes.md"), "work in progress");
    const ran = plain(w, ["--remove-files"]);
    notes.dirtyCheckout = clean(ran.output).split("\n").filter((line) => /Keeping|remove/.test(line));
    checks.keepsCheckoutWithWork = existsSync(join(w.repo, "my-notes.md")) && !existsSync(w.home) && /not committed/.test(ran.output) && /except its checkout/.test(ran.output);
  }

  if (linux) {
    // 2 and 3. Wrong answers are asked again; 1 keeps the files.
    {
      const w = make();
      const before = rcLines(w);
      const ran = await terminal(w, [
        { when: /Choose 1 or 2/g, say: "" },
        { when: /Choose 1 or 2/g, say: "3" },
        { when: /Choose 1 or 2/g, say: "1" },
      ]);
      const prompts = clean(ran.output).split("Choose 1 or 2").length - 1;
      notes.keep = { code: ran.code, prompts, systemctl: existsSync(w.log) ? readFileSync(w.log, "utf8").trim().split("\n") : [] };
      checks.wrongAnswersAskedAgain = prompts === 3;
      checks.keepRemovesServiceAndCommandOnly = ran.code === 0 && existsSync(join(w.repo, "scripts", "perry.ts")) && existsSync(join(w.home, "files", "made.txt"))
        && !existsSync(join(w.home, "bin", "perry")) && JSON.stringify(rcLines(w)) === JSON.stringify(before)
        && existsSync(w.log) && /disable --now perry-runner/.test(readFileSync(w.log, "utf8"));
    }

    // 4. 2, then not "remove".
    {
      const w = make();
      const ran = await terminal(w, [
        { when: /Choose 1 or 2/g, say: "2" },
        { when: /Type remove/g, say: "yes" },
      ]);
      notes.notConfirmed = clean(ran.output).split("\n").slice(-3);
      checks.unconfirmedRemoveChangesNothing = ran.code !== 0 && intact(w) && !existsSync(w.log) && /Nothing was changed/.test(ran.output);
    }

    // 5. 2, then "remove".
    {
      const w = make();
      const ran = await terminal(w, [
        { when: /Choose 1 or 2/g, say: "2" },
        { when: /Type remove/g, say: "remove" },
      ]);
      const [bashrc, profile] = rcLines(w);
      notes.removed = { code: ran.code, bashrc, profile, tail: clean(ran.output).split("\n").slice(-5) };
      checks.removeDeletesPerry = ran.code === 0 && !existsSync(w.repo) && !existsSync(w.home);
      checks.removeTakesOnlyPerrysPathLines = !/added by Perry/.test(bashrc + profile) && bashrc.includes("alias ll='ls -l'") && bashrc.includes("export EDITOR=vim") && profile.includes("umask 022");
    }
  }
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  for (const w of worlds) try { rmSync(w.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, `result-${process.platform}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ platform: process.platform, checks, passed: result.passed }, null, 2));
process.exit(result.passed ? 0 : 1);
