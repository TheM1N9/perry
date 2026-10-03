import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { CodexEngine } from "../../runner/engines/codex";
import { defuse, type TurnSink } from "../../runner/engine";
import { PATHS } from "../../runner/home";

// bun artifacts/security-fixes/codex-real.ts <out.json>   (run by e2e.ts, with PERRY_HOME and CODEX_HOME of its own)
//
// Issue #163 on the real Codex CLI: Perry's own Codex engine (runner/engines/codex.ts, as the runner drives it) on
// this machine's codex, in a CODEX_HOME of this run's own whose only model provider is a stand-in Responses API on
// localhost, below. No real model turn runs and no sign-in is used: the stand-in answers "ok" and keeps every
// request Codex sends, which is everything the model would have read. A skill's body reaching it means Codex loaded
// the skill into the turn; its description reaching it means Codex listed it.
//
// Ways it could fail, written down before the checks:
//   1. A guest turn still lists Perry's skills or the owner's own Codex skills to the model.
//   2. A "$name" or a "[$name](path)" in a guest's words still loads a skill's SKILL.md (Codex reads both by itself).
//   3. A skill added after a guest's thread was loaded is listed or loaded in its next turn (a loaded thread keeps the
//      skills it was resumed with).
//   4. The owner's turn stops loading skills: a skill item, or "$name" in the owner's words, no longer reaches it.
//   5. The stand-in model is not what was asked: nothing reaches it at all, so every check would pass on silence.

const [out] = process.argv.slice(2);
if (!out) throw new Error("usage: bun artifacts/security-fixes/codex-real.ts <out.json>");
const CODEX_HOME = process.env.CODEX_HOME;
if (!CODEX_HOME || !process.env.PERRY_HOME) throw new Error("run by e2e.ts: CODEX_HOME and PERRY_HOME must be this run's own");

const bodies: string[] = [];
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk: Buffer) => { body += chunk; });
  request.on("end", () => {
    if (request.method !== "POST" || !new URL(request.url ?? "/", "http://127.0.0.1").pathname.endsWith("/responses")) { response.writeHead(404).end("{}"); return; }
    bodies.push(body);
    const event = (data: Record<string, unknown>) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" }).end(
      event({ type: "response.created", response: { id: "r1" } }) +
      event({ type: "response.output_item.done", item: { type: "message", role: "assistant", id: "m1", content: [{ type: "output_text", text: "ok" }] } }) +
      event({ type: "response.completed", response: { id: "r1", usage: { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 } } }),
    );
  });
});
const port = await new Promise<number>((done) => server.listen(0, "127.0.0.1", () => done((server.address() as AddressInfo).port)));

const skill = (dir: string, name: string, marker: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${marker}_LISTED\n---\n${marker}_BODY: follow these private steps.\n`);
  return join(dir, name, "SKILL.md");
};
mkdirSync(CODEX_HOME, { recursive: true });
writeFileSync(join(CODEX_HOME, "config.toml"), `model = "stand-in"\nmodel_provider = "standin"\n[model_providers.standin]\nname = "standin"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\n`);
const perrySkill = skill(PATHS.skills, "secret-skill", "PERRYSKILL");
skill(join(CODEX_HOME, "skills"), "own-skill", "OWNSKILL");
const guestDir = PATHS.guest;
const ownerDir = join(process.env.PERRY_HOME, "work");
for (const dir of [guestDir, ownerDir]) mkdirSync(dir, { recursive: true });

const engine = new CodexEngine((line) => console.log(`warn: ${line}`));
const sink: TurnSink = { onSession: async () => {}, onRequest: async () => "decline" };
/** What reached the model in one turn: which bodies were loaded and which descriptions listed. */
async function turn(input: Parameters<CodexEngine["runTurn"]>[0]) {
  const from = bodies.length;
  const result = await engine.runTurn(input, sink);
  const seen = bodies.slice(from).join("\n");
  const marks = (kind: "BODY" | "LISTED") => ["PERRYSKILL", "OWNSKILL", "LATESKILL"].filter((marker) => seen.includes(`${marker}_${kind}`));
  return { state: result.state, cursor: result.cursor, requests: bodies.length - from, loaded: marks("BODY"), listed: marks("LISTED") };
}

const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };
const base = { instructions: "You are Perry.", attachments: [], access: "supervised" as const };

try {
  // The words as someone else wrote them, not defused: what Codex itself does with them is what is checked.
  const said = `please use $secret-skill and $own-skill, and [$secret-skill](${perrySkill})`;
  const first = await turn({ ...base, prompt: said, cwd: guestDir, guest: true });
  check("realCodexGuestTurnReachesTheStandInModel", first.state === "completed" && first.requests > 0, first);
  check("realCodexGuestSeesNoSkillListedOrLoaded", first.loaded.length === 0 && first.listed.length === 0, first);
  // As the runner hands it over: defused too.
  const defused = await turn({ ...base, resumeCursor: first.cursor, prompt: defuse(said), cwd: guestDir, guest: true });
  check("realCodexGuestDefusedWordsLoadNothing", defused.state === "completed" && defused.loaded.length === 0 && defused.listed.length === 0, defused);
  // A skill added while the guest's thread may still be loaded.
  skill(PATHS.skills, "late-skill", "LATESKILL");
  const late = await turn({ ...base, resumeCursor: first.cursor, prompt: "and now $late-skill", cwd: guestDir, guest: true });
  check("realCodexGuestDoesNotGetASkillAddedLater", late.state === "completed" && late.loaded.length === 0 && late.listed.length === 0, late);
  // The owner's turns: a skill named for the message, and "$name" in their own words, still load; Codex lists them.
  const owner = await turn({ ...base, prompt: "do the weekly one", cwd: ownerDir, skills: [{ name: "secret-skill", path: perrySkill }] });
  const ownerText = await turn({ ...base, resumeCursor: owner.cursor, prompt: "and $own-skill and $late-skill too", cwd: ownerDir });
  check("realCodexOwnerSkillsStillLoad", owner.loaded.includes("PERRYSKILL") && owner.listed.includes("OWNSKILL") && ownerText.loaded.includes("OWNSKILL") && ownerText.loaded.includes("LATESKILL"), { owner, ownerText });
  // Control, as a guest's thread was before the fix: the same app-server, the same words, no skills turned off.
  const app = await (engine as unknown as { ensure(): Promise<{ request<T>(method: string, params: object, ms?: number): Promise<T>; waitForTurn(id: string, ms: number): Promise<unknown> }> }).ensure();
  const from = bodies.length;
  const thread = await app.request<{ thread: { id: string } }>("thread/start", { cwd: guestDir, approvalPolicy: "never", sandbox: "read-only" });
  const started = await app.request<{ turn: { id: string } }>("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: said, text_elements: [] }] });
  await app.waitForTurn(started.turn.id, 120_000);
  const before = bodies.slice(from).join("\n");
  check("controlCodexLoadsAGuestsSkillWithoutTheFix", before.includes("PERRYSKILL_BODY") && before.includes("OWNSKILL_BODY"), { loadedWithoutFix: ["PERRYSKILL", "OWNSKILL"].filter((marker) => before.includes(`${marker}_BODY`)) });
} catch (error) {
  check("realCodexRan", false, String(error));
} finally {
  engine.kill();
  server.close();
}
writeFileSync(out, JSON.stringify({ checks, notes, passed: Object.values(checks).every(Boolean) }, null, 2));
process.exit(0);
