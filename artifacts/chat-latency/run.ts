import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { perry, sleep } from "../engine-acp/harness";

// bun artifacts/chat-latency/run.ts <outDir>
// How long a web chat reply takes to show, from the owner pressing send to the
// first streamed words and the finished message, measured on the page itself: a
// fresh Perry (production build, `pnpm build` first) and the real runner on real
// Codex (PERRY_E2E_MODEL, by default gpt-6-luna), with headless Chrome sending
// from the composer.
//
//   chat A: three messages; the first starts a Codex thread, the next two resume it.
//   two quiet minutes, then a fourth message in chat A: Codex must be given the
//     time now with it, not the time the chat's thread started.
//   chats B and C: a first message each, in new chats, after the runner has had
//     time to start a thread ahead of them.
//
// Timestamps from the page, the server and the runner share this machine's clock.
// `[timing] <ms> <step>` lines in the server's and runner's output, where a build
// has them, place each step between send and the first words in each turn's
// `steps`. Perry has none: before/ and after/ were run with console.log lines
// added for the run at each step (the claim, the skills scan, thread/resume or
// start, turn/start, every app-server notification, the first delta, each flush).
//
// Ways it could fail, written down before the checks:
//   1. The page shows nothing streamed: the reply appears only when finished.
//   2. The streamed text disappears for a visible moment before the finished
//      message shows (the page falls back to "Thinking", or shows nothing).
//   3. A new chat's first words take as long as they did before a thread was
//      started ahead of it, because the runner never took it (the instructions
//      differ from turn to turn, so no spare ever matches).
//   4. A resumed chat is told the time its thread started, not the time now.
//   5. A new chat that took a thread started ahead of it fails or is answered
//      with another chat's context.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/chat-latency/run.ts <outDir>");
const MODEL = process.env.PERRY_E2E_MODEL ?? "gpt-6-luna";
/** A gap shorter than this between the streamed words and the finished message is one frame of re-rendering, not a visible one. */
const VISIBLE_GAP_MS = 250;
const QUIET_MS = 125_000;

const p = await perry({ name: "chat-latency", outDir, runnerEnv: () => ({}) });
const { KEY, call, check, notes, until, computers } = p;
const timing = (log: string) => log.split("\n").flatMap((line) => {
  const found = /\[timing\] (\d+) (.+)$/.exec(line.trim());
  return found ? [{ at: Number(found[1]), label: found[2] }] : [];
});

/** What the page showed after send, in ms from the click: the first streamed words, each growth, and the finished reply. */
type Seen = { clickAt: number; pendingMs?: number; firstStreamMs?: number; finishedMs?: number; streamSteps: number;
  gaps: Array<{ fromMs: number; toMs: number; showing: string }>; growth: Array<{ ms: number; chars: number }>; final: string };
/** `queuedMs`: how long the turn waited for the runner, which runs one turn at a time (Perry's own record of it). */
type Turn = { chat: string; prompt: string; seen: Seen; queuedMs?: number; steps: Array<{ ms: number; label: string }> };

/** A Codex thread's own record, from its rollout in CODEX_HOME: when the thread was started, and everything it was given. */
const SESSIONS = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
function rolloutOf(thread: string | undefined) {
  const file = thread ? readdirSync(SESSIONS, { recursive: true, encoding: "utf8" }).find((name) => name.endsWith(`${thread}.jsonl`)) : undefined;
  if (!file) return null;
  const text = readFileSync(join(SESSIONS, file), "utf8");
  const meta = JSON.parse(text.slice(0, text.indexOf("\n"))) as { payload?: { timestamp?: string } };
  return { text, startedAt: Date.parse(meta.payload?.timestamp ?? "") };
}

try {
  p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  p.start("runner");
  await until(async () => (await computers()).some((item) => item.online && item.engines.some((engine) => engine.kind === "codex" && engine.signedIn)), "the runner with Codex signed in", 120);
  const newChat = async () => {
    const id = await call<string>("dashboard:createChat", { key: KEY });
    await call("dashboard:setChatModel", { key: KEY, id, model: MODEL, engine: "codex" });
    return id;
  };

  const { evaluate, send, errors } = await p.openBrowser();
  const open = async (chat: string) => {
    await send("Page.navigate", { url: `${p.BASE}/chat/${chat}` });
    await until(() => evaluate(`Boolean(document.querySelector('#composer'))`), "the chat's composer", 30);
    await sleep(2_000);
  };

  const turns: Turn[] = [];
  const chats = new Map<string, string>();
  const threadOf = async (chat: string) => { const row = await p.conversation(chat); return (row.resume?.cursor ?? row.codexThreadId) as string | undefined; };
  const say = async (name: string, prompt: string) => {
    const serverFrom = p.logs.server.length;
    const runnerFrom = p.logs.runner.length;
    const seen = await evaluate(`new Promise((resolve, reject) => {
      const finished = () => document.querySelectorAll('[data-role="assistant"]:not([data-streaming]):not([data-thinking])');
      const before = finished().length;
      const box = document.querySelector('#composer');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(prompt)});
      box.dispatchEvent(new Event('input', { bubbles: true }));
      const seen = { streamSteps: 0, gaps: [], growth: [], final: '' };
      let showing = 'nothing', since = 0, lastChars = 0;
      const look = () => {
        const ms = Date.now() - seen.clickAt;
        if (seen.pendingMs === undefined && document.querySelector('[data-role="user"][data-pending]')) seen.pendingMs = ms;
        const streaming = document.querySelector('[data-streaming]');
        const now = streaming ? 'streaming' : document.querySelector('[data-thinking]') ? 'thinking' : finished().length > before ? 'finished' : 'nothing';
        if (streaming) {
          const chars = streaming.innerText.length;
          if (seen.firstStreamMs === undefined) seen.firstStreamMs = ms;
          if (chars !== lastChars) { seen.streamSteps++; seen.growth.push({ ms, chars }); lastChars = chars; }
        }
        // After words first showed, anything but more words or the finished reply is a gap.
        if (now !== showing) {
          if (seen.firstStreamMs !== undefined && showing !== 'streaming' && showing !== 'finished' && since >= seen.firstStreamMs) seen.gaps.push({ fromMs: since, toMs: ms, showing });
          showing = now; since = ms;
        }
        if (now === 'finished') {
          seen.finishedMs = ms;
          seen.final = [...finished()].at(-1).innerText;
          observer.disconnect(); clearInterval(poll); resolve(seen);
        } else if (ms > 240000) { observer.disconnect(); clearInterval(poll); reject(new Error('no reply within 4 minutes')); }
      };
      const observer = new MutationObserver(look);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
      const poll = setInterval(look, 50);
      seen.clickAt = Date.now();
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })`) as Seen;
    await sleep(1_500);
    const steps = [...timing(p.logs.server.slice(serverFrom)), ...timing(p.logs.runner.slice(runnerFrom))]
      .sort((a, b) => a.at - b.at).map((step) => ({ ms: step.at - seen.clickAt, label: step.label }));
    const queued = p.turnsOf(chats.get(name)!).filter((row) => row.createdAt >= seen.clickAt).at(0);
    const turn = { chat: name, prompt, seen, steps, queuedMs: queued?.startedAt ? queued.startedAt - queued.createdAt : undefined };
    turns.push(turn);
    console.log(`${name}: ${prompt.slice(0, 40)}: first words ${seen.firstStreamMs} ms, finished ${seen.finishedMs} ms, queued ${turn.queuedMs} ms`);
    await sleep(3_000);
    return turn;
  };

  const a = await newChat();
  chats.set("A", a);
  await open(a);
  const a1 = await say("A", "In four short sentences, explain why the sky is blue.");
  await say("A", "Now in four short sentences, why sunsets are red.");
  await say("A", "And in four short sentences, why clouds are white.");

  // Quiet for two minutes: long enough for the clock to move on, and for a thread started ahead to sit idle.
  await sleep(QUIET_MS);
  const later = await say("A", "One more: in one sentence, why is grass green?");
  // What Codex was given, from the thread's own record (its rollout in CODEX_HOME): the last "It is now" must be the time of the last message.
  const timezone = await call<string>("jobs:ownerTimezone", {});
  const thread = await threadOf(a);
  const given = [...(rolloutOf(thread)?.text ?? "").matchAll(/It is now [^"\\]*? at (\d{2}:\d{2})/g)].map((found) => found[1]);
  const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit" });
  const minutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  const off = given.length ? Math.abs(minutes(given.at(-1)!) - minutes(clock(later.seen.clickAt))) : null;
  check("resumedChatIsGivenTheTimeNow", off !== null && Math.min(off, 24 * 60 - off) <= 1,
    { given, firstMessageAt: clock(a1.seen.clickAt), lastMessageAt: clock(later.seen.clickAt), timezone, thread });

  const b = await newChat();
  chats.set("B", b);
  await open(b);
  const b1 = await say("B", "In four short sentences, explain why the sea is salty.");
  const c = await newChat();
  chats.set("C", c);
  await open(c);
  const c1 = await say("C", "In four short sentences, explain why leaves change colour in autumn.");

  // A new chat's first message went to a thread the runner had started ahead of it, not one started when it came.
  for (const [name, chat, first] of [["B", b, b1], ["C", c, c1]] as const) {
    const thread = await threadOf(chat);
    const startedAt = rolloutOf(thread)?.startedAt;
    check(`chat${name}TookAThreadStartedAhead`, startedAt !== undefined && startedAt < first.seen.clickAt - 1_000,
      { thread, threadStartedMsBeforeSend: startedAt === undefined ? null : first.seen.clickAt - startedAt });
  }
  for (const turn of turns) {
    check(`${turn.chat}: "${turn.prompt.slice(0, 32)}" streamed`, turn.seen.firstStreamMs !== undefined && turn.seen.streamSteps >= 1, { firstStreamMs: turn.seen.firstStreamMs, steps: turn.seen.streamSteps });
  }
  const visible = turns.flatMap((turn) => turn.seen.gaps.filter((gap) => gap.toMs - gap.fromMs >= VISIBLE_GAP_MS));
  check("noVisibleGapBeforeFinished", visible.length === 0, { visible, all: turns.flatMap((turn) => turn.seen.gaps) });
  // Each new chat answers its own question: nothing from another chat's thread came with it.
  check("newChatsAnswerTheirOwnQuestion", /salt/i.test(b1.seen.final) && /leaf|leaves|chlorophyll/i.test(c1.seen.final) && !/sky|sunset|cloud/i.test(b1.seen.final + c1.seen.final),
    { b: b1.seen.final.slice(0, 300), c: c1.seen.final.slice(0, 300) });
  notes.pageErrors = errors;
  notes.model = MODEL;
  notes.firstWordsMs = Object.fromEntries(turns.map((turn, index) => [`${index + 1} ${turn.chat}: ${turn.prompt.slice(0, 40)}`, turn.seen.firstStreamMs]));
  await p.finish({ turns: turns.map((turn) => ({
    chat: turn.chat,
    prompt: turn.prompt,
    pendingMs: turn.seen.pendingMs,
    firstWordsMs: turn.seen.firstStreamMs,
    finishedMs: turn.seen.finishedMs,
    queuedMs: turn.queuedMs,
    streamSteps: turn.seen.streamSteps,
    gaps: turn.seen.gaps,
    growth: turn.seen.growth,
    reply: turn.seen.final.slice(0, 400),
    steps: turn.steps,
  })) });
} catch (error) {
  check("ran", false, String(error));
  await p.finish();
}
process.exit(0);
