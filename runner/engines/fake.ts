import { randomUUID } from "node:crypto";
import { ACCESSES } from "../../convex/lib/commands";
import { ENGINE_LABELS, isEngine } from "../../convex/lib/engines";
import type { Engine, EngineCapabilities, EngineStatus, LoginFlow, TurnHandle, TurnInput, TurnResult, TurnSink } from "../engine";

/**
 * A scripted engine, for end-to-end checks only: `PERRY_E2E_FAKE_ENGINE=claude`
 * puts it in the place of that engine on this runner, signed in, so a check
 * can run two engines at once with one real subscription
 * (artifacts/engines-together/run.ts). Never set outside a check.
 *
 * Its reply is written a word every quarter second, for as long as the prompt
 * asks with "fake-seconds:<n>" (one second otherwise), and names the model it
 * was given and the prompt's "tag:<word>". Each turn is one command item in
 * the trace. A steer joins the reply; interrupt stops it. Signing out and in
 * again works, and is kept only while the runner runs.
 */

const WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function fakeEngine(): Engine | null {
  const kind = process.env.PERRY_E2E_FAKE_ENGINE;
  return isEngine(kind) ? new FakeEngine(kind) : null;
}

class FakeEngine implements Engine {
  readonly label: string;
  readonly capabilities: EngineCapabilities = {
    steer: "native",
    compaction: { type: "native" },
    approvals: false,
    sandbox: { win32: ACCESSES, darwin: ACCESSES, linux: ACCESSES },
    images: false,
    modelSwitchInSession: true,
    usage: "partial",
    quickTurns: false,
  };
  private signedIn = true;
  private turns = new Map<string, { stopped: boolean; steers: string[] }>();

  constructor(readonly kind: Engine["kind"]) {
    this.label = `${ENGINE_LABELS[kind]} (fake)`;
  }

  async status(): Promise<EngineStatus> {
    return {
      kind: this.kind,
      installed: true,
      version: "0.0.0-fake",
      signedIn: this.signedIn,
      auth: this.signedIn ? { type: "fake", label: "Fake account" } : {},
      models: this.signedIn ? [
        { id: "fake-large", name: "Fake Large", isDefault: false, efforts: ["low", "high"], defaultEffort: "high" },
        { id: "fake-small", name: "Fake Small", isDefault: true, efforts: ["low", "high"], defaultEffort: "low" },
      ] : [],
    };
  }

  async login(): Promise<LoginFlow> {
    this.signedIn = true;
    return { interaction: null, done: Promise.resolve(), cancel: () => {} };
  }

  async logout(): Promise<void> {
    this.signedIn = false;
  }

  async runTurn(input: TurnInput, sink: TurnSink): Promise<TurnResult> {
    if (!this.signedIn) throw new Error(`${this.label} is signed out.`);
    const cursor = input.resumeCursor ?? `fake-session-${randomUUID()}`;
    if (!input.resumeCursor) await sink.onSession(cursor);
    const turnId = `fake-turn-${randomUUID()}`;
    const turn = { stopped: false, steers: [] as string[] };
    this.turns.set(turnId, turn);
    sink.onStarted?.({ cursor, turnId });
    const seconds = Number(input.prompt.match(/fake-seconds:(\d+)/)?.[1] ?? 1);
    const tag = input.prompt.match(/tag:(\S+)/)?.[1] ?? "untagged";
    const step = { id: `fake-step-${turnId}`, type: "command_execution" as const, title: `fake step ${tag}`, input: `$ fake ${tag}`, raw: { tag } };
    sink.onEvent?.({ type: "item", phase: "started", item: { ...step, status: "running" }, atMs: Date.now() });
    let text = `FAKE ${this.kind}/${input.model ?? "default"} ${tag}:`;
    const itemId = `fake-message-${turnId}`;
    const write = (delta: string) => {
      text += delta;
      sink.onEvent?.({ type: "text", stream: "assistant", itemId, delta, text });
    };
    try {
      const until = Date.now() + seconds * 1000;
      for (let index = 0; Date.now() < until && !turn.stopped; index++) {
        write(` ${WORDS[index % WORDS.length]}`);
        for (const steer of turn.steers.splice(0)) write(` [steered: ${steer}]`);
        await sleep(250);
      }
      for (const steer of turn.steers.splice(0)) write(` [steered: ${steer}]`);
      sink.onEvent?.({ type: "item", phase: "completed", item: { ...step, status: "completed", output: `fake ${tag} done` }, atMs: Date.now() });
      sink.onEvent?.({ type: "usage", state: "partial", usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 } });
      return { state: turn.stopped ? "interrupted" : "completed", cursor, text, images: [] };
    } finally {
      this.turns.delete(turnId);
    }
  }

  async steer(handle: TurnHandle, message: { prompt: string }): Promise<void> {
    const turn = this.turns.get(handle.turnId);
    if (!turn) throw new Error("no active turn to steer");
    turn.steers.push(message.prompt);
  }

  async interrupt(handle: TurnHandle): Promise<void> {
    const turn = this.turns.get(handle.turnId);
    if (turn) turn.stopped = true;
  }

  async compact(): Promise<void> {}

  kill(): void {
    for (const turn of this.turns.values()) turn.stopped = true;
  }
}
