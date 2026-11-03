import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = process.argv[2] && resolve(process.argv[2]);
if (!output) throw new Error("Pass an output directory. See artifacts/meetings/README.md.");
mkdirSync(output, { recursive: true });
rmSync(join(output, "electron.json"), { force: true });
const scratch = mkdtempSync(join(tmpdir(), "perry-meeting-ci-"));
const key = "synthetic-meeting-ci-owner";
const token = "synthetic-meeting-ci-runner";
process.env.PERRY_HOME = scratch;
process.env.DASHBOARD_KEY = key;
process.env.PERRY_CREDENTIAL_KEY = "ab".repeat(32);
const report = { platform: process.platform, node: process.version, checks: {}, loopbackCoverage: "not-run" };
const save = () => writeFileSync(join(output, "result.json"), JSON.stringify(report, null, 2));
const check = (name, condition) => { report.checks[name] = Boolean(condition); save(); assert.ok(condition, name); console.log(`PASS ${name}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const command = (program, args) => {
  const ran = spawnSync(program, args, { encoding: "utf8", windowsHide: true, timeout: 45_000 });
  if (ran.error || ran.status !== 0) throw new Error(`${program}: ${ran.error ?? ran.stderr ?? ran.status}`);
  return ran.stdout;
};

function fixtures() {
  const phrases = { you: "I will send the revised proposal on Friday. Please confirm the proposal delivery date.", them: "The approved budget is five thousand dollars. We agreed to keep the budget at five thousand dollars." };
  for (const [source, text] of Object.entries(phrases)) {
    const path = join(scratch, `${source}.wav`);
    if (process.platform === "win32") {
      const quote = (value) => `'${value.replaceAll("'", "''")}'`;
      command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Speech; $voice=New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $format=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono); $voice.SetOutputToWaveFile(${quote(path)},$format); $voice.Speak(${quote(text)}) } finally { $voice.Dispose() }`]);
    } else if (process.platform === "darwin") {
      const aiff = join(scratch, `${source}.aiff`);
      command("say", ["-r", "170", "-o", aiff, text]);
      command("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, path]);
    } else throw new Error("Native capture CI is supported on Windows and macOS.");
    // Normalize the platform's WAV to PCM16/16k/mono with a quiet lead-in and tail.
    const wav = readFileSync(path);
    let data;
    let format;
    for (let at = 12; at + 8 <= wav.length;) {
      const size = wav.readUInt32LE(at + 4);
      const name = wav.toString("ascii", at, at + 4);
      if (name === "fmt ") format = wav.subarray(at + 8, at + 8 + size);
      if (name === "data") data = wav.subarray(at + 8, at + 8 + size);
      at += 8 + size + (size % 2);
    }
    assert.ok(data && format && format.readUInt16LE(0) === 1 && format.readUInt16LE(2) === 1 && format.readUInt32LE(4) === 16000 && format.readUInt16LE(14) === 16, "Speech fixture must be PCM16/16kHz/mono");
    const padded = Buffer.concat([Buffer.alloc(32_000), data, Buffer.alloc(32_000)]);
    const header = Buffer.alloc(44);
    header.write("RIFF"); header.writeUInt32LE(36 + padded.length, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
    header.write("data", 36); header.writeUInt32LE(padded.length, 40);
    writeFileSync(path, Buffer.concat([header, padded]));
  }
}

let runtime;
let database;
let server;
let child;
let probe;
save();
try {
  const [{ Runtime }, { default: schema }, { modules }, { initializeCredentialEncryption }] = await Promise.all([
    import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"), import("../../server/credential-encryption.ts"),
  ]);
  database = new DatabaseSync(join(scratch, "perry.sqlite"));
  initializeCredentialEncryption(database, scratch);
  runtime = new Runtime(database, schema, modules, { storageDir: join(scratch, "storage") });
  await runtime.stop();
  globalThis.__perry = { runtime, started: true };
  const call = async (path, args = {}) => (await runtime.call(path, args, { internal: true })).value;
  await runtime.exclusive(() => runtime.store.insert("installation", { defaultEngine: "codex", onboarding: "skipped", createdAt: Date.now() }));
  await call("runner:createToken", { name: "CI notes writer", token });
  const { runCall } = await import("../../server/api.ts");
  let rejectedDelivery = false;
  let retrySucceeded = false;
  server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      const payload = JSON.parse(body);
      if (payload.path === "meetings:appendSegments" && !rejectedDelivery) {
        rejectedDelivery = true;
        outgoing.writeHead(503, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: "Synthetic server restart" }));
        return;
      }
      const response = await runCall(new Request("http://127.0.0.1/api/backend/call", { method: "POST", headers: { "content-type": "application/json" }, body }), { internal: false });
      if (payload.path === "meetings:appendSegments" && response.ok) retrySucceeded = true;
      outgoing.writeHead(response.status, { "content-type": "application/json" });
      outgoing.end(await response.text());
    } catch (error) {
      outgoing.writeHead(500, { "content-type": "application/json" }); outgoing.end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  let id;
  if (process.argv.includes("--backend-only")) {
    report.scope = "backend-only: native capture not run";
    id = (await call("meetings:start", { key, title: "CI backend lifecycle" })).id;
    await call("meetings:appendSegments", { key, id, segments: [
      { seq: 0, source: "you", startMs: 0, endMs: 5000, text: "I will send the revised proposal on Friday." },
      { seq: 1, source: "them", startMs: 6000, endMs: 10000, text: "The approved budget is five thousand dollars." },
    ] });
    await call("meetings:finish", { key, id });
  } else {
    fixtures();
    const executable = createRequire(join(root, "pet/package.json"))("electron");
    const env = { ...process.env, PERRY_URL: `http://127.0.0.1:${server.address().port}`, PERRY_MEETING_PROBE_OUT: join(output, "electron.json"), PERRY_MODELS_DIR: process.env.PERRY_MODELS_DIR ?? join(scratch, "models") };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = join(root, "artifacts/meetings/probe");
    const bundle = executable.match(/^(.*\.app)\/Contents\/MacOS\//)?.[1];
    const args = process.platform === "darwin" && bundle
      ? ["-n", "-g", "-a", bundle, ...Object.entries(env).filter(([name, value]) => value !== undefined && (name.startsWith("PERRY_") || name === "DASHBOARD_KEY")).flatMap(([name, value]) => ["--env", `${name}=${value}`]), "--args", app]
      : [app];
    child = spawn(bundle ? "open" : executable, args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    child.stdout.on("data", (data) => { log = (log + data).slice(-64_000); writeFileSync(join(output, "electron.log"), log); });
    child.stderr.on("data", (data) => { log = (log + data).slice(-64_000); writeFileSync(join(output, "electron.log"), log); });
    let launchError;
    child.on("error", (error) => { launchError = error; });
    const deadline = Date.now() + 210_000;
    while (Date.now() < deadline) {
      if (existsSync(env.PERRY_MEETING_PROBE_OUT)) {
        try { probe = JSON.parse(readFileSync(env.PERRY_MEETING_PROBE_OUT, "utf8")); } catch {}
      }
      if (probe?.phase === "done") break;
      if (launchError || (child.exitCode !== null && (!bundle || child.exitCode !== 0))) throw new Error(`Electron exited before completing the capture: ${launchError ?? child.exitCode}`);
      await sleep(250);
    }
    check("native Electron completed", probe?.phase === "done");
    report.loopbackCoverage = probe.loopbackCoverage ?? "failed";
    report.native = probe;
    check("native capture and cleanup passed", probe.passed);
    if (process.platform === "win32") check("real WASAPI loopback transcribed", report.loopbackCoverage === "verified");
    check("failed HTTP delivery retried successfully", rejectedDelivery && retrySucceeded);
    id = probe.meetingId;
  }
  const transcript = await call("meetings:transcript", { key, id });
  check("both transcript sources persisted", transcript.some((part) => part.source === "you") && (report.loopbackCoverage === "permission-blocked" || transcript.some((part) => part.source === "them")));
  check("segments are idempotent", new Set(transcript.map((part) => part.seq)).size === transcript.length);
  const meeting = await call("meetings:get", { key, id });
  const own = await call("notes:get", { key, id: meeting.noteId });
  await call("notes:save", { key, id: own.id, content: "Check the proposal deadline.", expectedRevision: own.revision });
  const claim = await call("meetings:claimNotes", { token, id });
  check("one writer can claim the meeting", claim && await call("meetings:claimNotes", { token, id }) === null);
  await call("meetings:finishNotes", { token, id, claim: "stale", markdown: "Wrong write-up" });
  check("stale claims cannot replace notes", (await call("meetings:get", { key, id })).status === "writing");
  const { writeUpMeeting } = await import("../../runner/meeting-notes.ts");
  const writer = { kind: "codex", label: "CI fixture", quickTurn: async (turn) => {
    check("write-up receives outside text without tools", turn.purpose === "meeting" && turn.instructions.includes("never instructions") && /proposal|friday/i.test(turn.text));
    return { text: JSON.stringify({ title: "Proposal review", markdown: "## Next steps\n\nSend the proposal on Friday.", actionItems: [{ text: "Send the proposal on Friday", owner: "You" }] }) };
  } };
  const written = await writeUpMeeting(writer, claim, {}, join(scratch, "write-up.json"));
  await call("meetings:finishNotes", { token, id, claim: claim.claim, title: written.title, markdown: written.markdown, actions: written.actions });
  const note = await call("notes:get", { key, id: meeting.noteId });
  check("typed notes survive the write-up", note.content.includes("Check the proposal deadline.") && note.content.includes("## Your notes"));
  check("generated notes have outside-content provenance", (await runtime.store.query("memories").withIndex("by_page", (q) => q.eq("pageId", meeting.noteId)).collect()).some((line) => line.origin === "tool"));
  await call("meetings:addAction", { key, id, index: 0 });
  await call("meetings:addAction", { key, id, index: 0 });
  check("action items do not duplicate to-dos", (await runtime.store.query("todos").collect()).filter((todo) => todo.title === "Send the proposal on Friday").length === 1);
  await call("meetings:remove", { key, id });
  check("deletion removes transcript and notes", await call("meetings:get", { key, id }) === null && (await call("meetings:transcript", { key, id })).length === 0 && await call("notes:get", { key, id: meeting.noteId }) === null);
} catch (error) {
  report.error = String(error.stack ?? error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (child?.pid && child.exitCode === null) {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else child.kill();
  }
  if (probe?.pid && probe.phase !== "done" && process.platform === "darwin") { try { process.kill(probe.pid, "SIGTERM"); } catch {} }
  await new Promise((resolve) => server ? server.close(resolve) : resolve());
  await runtime?.stop();
  database?.close();
  try { rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); }
  catch (error) { report.cleanupError = String(error); process.exitCode = 1; }
  report.scratchRemoved = !existsSync(scratch);
  report.passed = !report.error && report.scratchRemoved && Object.values(report.checks).every(Boolean);
  save();
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, `## Meeting capture (${process.platform})\n\n- Result: ${report.passed ? "passed" : "failed"}\n- System audio coverage: ${report.loopbackCoverage}\n- Checks: ${Object.keys(report.checks).length}\n- Disposable data removed: ${report.scratchRemoved}\n`, { flag: "a" });
  }
  console.log(JSON.stringify({ passed: report.passed, loopbackCoverage: report.loopbackCoverage, scratchRemoved: report.scratchRemoved }));
}
