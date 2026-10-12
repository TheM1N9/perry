/** Native Windows launcher integration check. No tasks, login entries, engines or accounts are touched. */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { servicePlan } from "../../scripts/service";

const output = resolve(process.argv[2] ?? "artifacts/windows-background/results");
mkdirSync(output, { recursive: true });
if (process.platform !== "win32") {
  writeFileSync(join(output, "result.json"), JSON.stringify({ platform: process.platform, skipped: "Requires Windows; no installed Windows or screen recording verification." }, null, 2));
  console.log("Skipped native launcher integration: requires Windows.");
  process.exit(0);
}
const scratch = mkdtempSync(join(tmpdir(), "Perry O'Neil ü % & $ "));
const compiler = join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
const compile = (source: string, exe: string, target: "exe" | "winexe") => {
  const result = spawnSync(compiler, ["/nologo", `/target:${target}`, `/out:${exe}`, source], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    const error = `Compilation failed: ${result.stdout} ${result.stderr} ${result.error ?? ""}`;
    writeFileSync(join(output, "result.json"), JSON.stringify({ platform: process.platform, pass: false, error }, null, 2));
    throw new Error(error);
  }
};
const child = join(scratch, "child.exe");
const source = join(scratch, "child.cs");
writeFileSync(source, `using System; using System.IO; using System.Runtime.InteropServices;
class Child {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  static int Main(string[] args) {
    string home = Environment.GetEnvironmentVariable("PERRY_HOME");
    File.AppendAllText(Path.Combine(home, "starts.txt"), "started\\n");
    File.WriteAllLines(Path.Combine(home, "child.txt"), new string[] { Directory.GetCurrentDirectory(), String.Join("|", args), Environment.GetEnvironmentVariable("PERRY_CODEX_SANDBOX"), GetConsoleWindow().ToString(), System.Diagnostics.Process.GetCurrentProcess().Id.ToString() });
    for (int n = 0; n < 12000; n++) { Console.WriteLine(new string('x', 1000)); Console.Error.WriteLine("stderr"); }
    System.Threading.Thread.Sleep(3000);
    return 7;
  }
}`);
compile(source, child, "exe");
const context = { platform: process.platform, repo: scratch, bun: child, home: scratch, userHome: scratch, logFile: join(scratch, "runner.log"), env: { PERRY_HOME: scratch, PERRY_CODEX_SANDBOX: "workspace-write" }, user: "unused" };
const plan = servicePlan(context);
for (const file of plan.files) {
  mkdirSync(join(file.path, ".."), { recursive: true });
  writeFileSync(file.path, file.encoding === "utf16le" ? Buffer.from(`\ufeff${file.content}`, "utf16le") : file.content);
}
const exe = join(scratch, "service", "runner.exe");
compile(resolve("scripts/windows-launcher.cs"), exe, "winexe");
const evidence: Record<string, unknown> = { platform: process.platform, scratch };
const expect = (ok: unknown, what: string) => { if (!ok) throw new Error(what); evidence[what] = true; };
const run = () => new Promise<number | null>((done, fail) => {
  const proc = spawn(exe, [], { stdio: "ignore", windowsHide: true });
  proc.once("error", fail);
  proc.once("exit", done);
});
try {
  // The PE subsystem must be Windows GUI (2), independently of how this test starts it.
  const pe = readFileSync(exe);
  expect(pe.readUInt16LE(pe.readUInt32LE(0x3c) + 24 + 68) === 2, "GUI PE subsystem");
  const first = run();
  const deadline = Date.now() + 10_000;
  while (true) {
    try { readFileSync(join(scratch, "child.txt")); break; } catch { if (Date.now() > deadline) throw new Error("Child did not start"); }
    await new Promise((done) => setTimeout(done, 100));
  }
  expect(await run() === 0, "second launch exits cleanly");
  expect(await first === 7, "child failure reaches Task Scheduler");
  expect(readFileSync(join(scratch, "starts.txt"), "utf8") === "started\n", "one child for repeated launches");
  const facts = readFileSync(join(scratch, "child.txt"), "utf8").trim().split(/\r?\n/);
  expect(facts[0] === scratch, "cwd survives special characters");
  expect(facts[1] === `${join(scratch, "scripts", "perry.ts")}|run|--background`, "arguments survive special characters");
  expect(facts[2] === "workspace-write", "carried environment survives");
  expect(facts[3] === "0", "console child has no console");
  const { statSync, readdirSync } = await import("node:fs");
  const logs = readdirSync(scratch).filter((name) => /^runner\.log(?:\.[1-3])?$/.test(name));
  expect(logs.length === 4, "three rotated logs retained");
  expect(logs.every((name) => statSync(join(scratch, name)).size <= 1024 * 1024), "each log bounded to 1 MiB");
  expect(/^\d{4}-\d\d-\d\dT/.test(readFileSync(context.logFile, "utf8")), "logs have UTC timestamps");
  // A failed Process.Start must leave diagnostics and fail the task too.
  const broken = servicePlan({ ...context, bun: join(scratch, "missing.exe") });
  writeFileSync(broken.files[0].path, broken.files[0].content);
  expect(await run() === 1, "startup failure exits nonzero");
  expect(readFileSync(context.logFile, "utf8").includes("could not start"), "startup failure leaves a log");
  writeFileSync(plan.files[0].path, plan.files[0].content);
  const owned = spawn(exe, [], { stdio: "ignore", windowsHide: true });
  try {
    let ownedPid = Number(facts[4]);
    const until = Date.now() + 10_000;
    while (ownedPid === Number(facts[4])) {
      ownedPid = Number(readFileSync(join(scratch, "child.txt"), "utf8").trim().split(/\r?\n/)[4]);
      if (Date.now() > until) throw new Error("Second child did not start");
      await new Promise((done) => setTimeout(done, 100));
    }
    owned.kill();
    await new Promise((done) => owned.once("exit", done));
    await new Promise((done) => setTimeout(done, 500));
    let alive = true;
    try { process.kill(ownedPid, 0); } catch { alive = false; }
    expect(!alive, "launcher termination cleans up its owned child");
  } finally { if (owned.exitCode === null && owned.signalCode === null) owned.kill(); }
  evidence.pass = true;
} catch (error) {
  evidence.pass = false;
  evidence.error = String(error);
  process.exitCode = 1;
} finally {
  for (const suffix of ["", ".1", ".2", ".3"]) {
    const file = context.logFile + suffix;
    if (existsSync(file)) copyFileSync(file, join(output, `runner-log${suffix}.txt`));
  }
  writeFileSync(join(output, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
